// Análise de atendimentos com Claude: categoria, sentimento, resolução, qualidade do time, FAQ.
import Anthropic from "@anthropic-ai/sdk";
import { parseCaseDecision } from "./cases.mjs";
import { parseCalibration } from "./calibration.mjs";

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

const SYSTEM = `Você é auditor(a) de qualidade de atendimento ao cliente via grupos de WhatsApp de uma empresa brasileira.
Cada grupo reúne um cliente (uma ou mais pessoas) e o time de atendimento. Você recebe a transcrição de UM atendimento
(janela de conversa) e devolve uma avaliação objetiva em JSON, em português do Brasil.

Regras:
- "category": escolha exatamente uma das categorias permitidas; use "Outros" se nenhuma servir.
- "sentiment": como o cliente termina o atendimento (positivo, neutro, negativo, irritado).
- "satisfaction": 1 a 5, estimativa da satisfação do cliente.
- "resolved": true só se a demanda do cliente foi atendida/encerrada na conversa.
- "pending_on": "equipe" se a próxima ação é do time, "cliente" se o time aguarda o cliente, "ninguem" se encerrado.
- "quality_score": 0 a 10 para o time (cordialidade, clareza, agilidade, resolução, português).
- "holding_reply_without_followup": true se o time respondeu algo como "vou verificar" / "estamos verificando" e não voltou com solução.
- "team_feedback": uma entrada por integrante do time que escreveu na conversa, usando o código entre colchetes (ex.: A1).
- "topics": 1 a 4 assuntos curtos em minúsculas (ex.: "tela apagada", "troca de conteúdo").
- "customer_questions": perguntas reais do cliente reescritas de forma curta e genérica (servem para montar um FAQ).
- "issues": problemas do atendimento (demora, resposta genérica, erro de português, promessa não cumprida). Lista vazia se não houver.
- "summary": uma frase de até 200 caracteres.
- Mensagens de "Helpdesk interno" são de um time interno de apoio: não são do cliente nem do time avaliado.
  Não as avalie em "team_feedback" e não as trate como demanda do cliente.
Não invente fatos que não estão na conversa.`;

function schema(categories) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "category", "sentiment", "satisfaction", "resolved", "pending_on", "quality_score",
      "holding_reply_without_followup", "summary", "topics", "customer_questions", "issues", "team_feedback",
    ],
    properties: {
      category: { type: "string", enum: categories },
      sentiment: { type: "string", enum: ["positivo", "neutro", "negativo", "irritado"] },
      satisfaction: { type: "integer", enum: [1, 2, 3, 4, 5] },
      resolved: { type: "boolean" },
      pending_on: { type: "string", enum: ["equipe", "cliente", "ninguem"] },
      quality_score: { type: "number" },
      holding_reply_without_followup: { type: "boolean" },
      summary: { type: "string" },
      topics: { type: "array", items: { type: "string" } },
      customer_questions: { type: "array", items: { type: "string" } },
      issues: { type: "array", items: { type: "string" } },
      team_feedback: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "score", "strengths", "improve"],
          properties: {
            code: { type: "string" },
            score: { type: "number" },
            strengths: { type: "string" },
            improve: { type: "string" },
          },
        },
      },
    },
  };
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

// Monta a transcrição com códigos para cada integrante do time (A1, A2… / SUP).
export function buildTranscript(conv) {
  const codes = new Map();
  const roster = [];
  const lines = conv.messages.map((m) => {
    let who;
    if (m.author === "cliente") who = `Cliente (${m.name || "cliente"})`;
    else if (m.author === "helpdesk") who = `Helpdesk interno (${m.name || "helpdesk"})`;
    else {
      const key = m.attendant_id || `sup:${m.name}`;
      if (!codes.has(key)) {
        const code = m.author === "supervisor" ? `SUP${codes.size + 1}` : `A${codes.size + 1}`;
        codes.set(key, code);
        roster.push({ code, attendant_id: m.attendant_id || null, name: m.name });
      }
      who = `[${codes.get(key)}] ${m.name} (time)`;
    }
    const body = m.text ?? `[${m.type}]`;
    return `${fmtTime(m.at)} — ${who}: ${body}`;
  });
  return { transcript: lines.join("\n"), roster };
}

function buildParams(conv, categories, model) {
  const { transcript, roster } = buildTranscript(conv);
  const user = `Produto/número monitorado: ${conv.instance_name}
Grupo: ${conv.group_name}
Categorias permitidas: ${categories.join(" | ")}
Integrantes do time nesta conversa: ${roster.map((r) => `[${r.code}] ${r.name}`).join(", ") || "nenhum (time não respondeu)"}

Transcrição:
${transcript}`;
  return {
    roster,
    params: {
      model,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(categories) } },
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    },
  };
}

// Converte a resposta do modelo na análise salva (códigos A1/SUP1 → atendente).
function parseAnalysis(message, roster) {
  if (message.stop_reason === "refusal") throw new Error("Análise recusada pelo modelo");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Resposta sem texto (stop_reason=${message.stop_reason})`);
  const out = JSON.parse(text);
  out.team_feedback = (out.team_feedback || []).map((f) => {
    const r = roster.find((x) => x.code === f.code);
    return { ...f, attendant_id: r?.attendant_id ?? null, name: r?.name ?? f.code };
  });
  out.quality_score = Math.max(0, Math.min(10, Number(out.quality_score) || 0));
  return out;
}

const noKey = () => !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;

// Envia UM lote com todos os atendimentos encerrados ainda não analisados.
// Roda às 11h e às 16h (e pelo botão do painel). Não envia se já houver lote em andamento.
export async function submitAnalysisBatch(rpc, { limit = 1000, idleMinutes = 60, model = DEFAULT_MODEL } = {}) {
  if (noKey()) return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  const open = (await rpc("ai_batch_open", { p_kind: "analise" })) ?? [];
  if (open.length) return { ok: true, submitted: 0, skipped: "já existe um lote em andamento", batch: open[0].id };

  const pending = await rpc("ai_pending_conversations", { p_limit: limit, p_idle_minutes: idleMinutes });
  const items = pending?.items ?? [];
  if (!items.length) return { ok: true, submitted: 0 };
  const categories = pending?.categories?.length ? [...pending.categories] : ["Outros"];
  if (!categories.includes("Outros")) categories.push("Outros");

  const rosters = {};
  const requests = items.map((conv) => {
    const { roster, params } = buildParams(conv, categories, model);
    rosters[conv.id] = roster;
    return { custom_id: conv.id, params };
  });
  const batch = await new Anthropic().messages.batches.create({ requests });
  await rpc("ai_batch_create", { p_id: batch.id, p_rosters: rosters, p_kind: "analise" });
  return { ok: true, submitted: requests.length, batch: batch.id };
}

// Confere os lotes abertos (análise e casos); quando um termina, salva o resultado. Não chama o modelo.
export async function collectAnalysisBatches(rpc) {
  if (noKey()) return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  const open = (await rpc("ai_batch_open", {})) ?? [];
  if (!open.length) return { ok: true, batches: [] };
  const client = new Anthropic();
  const out = [];
  for (const b of open) {
    const info = await client.messages.batches.retrieve(b.id);
    if (info.processing_status !== "ended") {
      out.push({ batch: b.id, kind: b.kind, status: info.processing_status });
      continue;
    }
    const isCase = b.kind === "casos";
    const isCal = b.kind === "calibragem";
    let saved = 0;
    let closed = 0;
    const errors = [];
    let chunk = [];
    const flush = async () => {
      if (!chunk.length) return;
      if (isCal) {
        saved += await rpc("ai_save_calibrations", { p: chunk });
      } else if (isCase) {
        const r = await rpc("ai_save_cases", { p: chunk, p_checked_at: b.created_at });
        saved += r.checked;
        closed += r.closed;
      } else {
        saved += await rpc("ai_save_analyses", { p: chunk });
      }
      chunk = [];
    };
    for await (const r of await client.messages.batches.results(b.id)) {
      try {
        if (r.result.type !== "succeeded") throw new Error(r.result.type === "errored" ? r.result.error?.error?.message || "erro" : r.result.type);
        const msg = r.result.message;
        chunk.push(isCal
          ? parseCalibration(msg, b.rosters?.[r.custom_id] ?? {}, b.id)
          : isCase
          ? { id: r.custom_id, decision: parseCaseDecision(msg), model: msg.model }
          : { id: r.custom_id, analysis: parseAnalysis(msg, b.rosters?.[r.custom_id] ?? []), model: msg.model });
        if (chunk.length >= 200) await flush();
      } catch (e) {
        if (errors.length < 20) errors.push(`${r.custom_id}: ${e.message}`);
      }
    }
    await flush();
    const result = { saved, failed: info.request_counts.errored + info.request_counts.expired + info.request_counts.canceled, errors };
    if (isCase) result.closed = closed;
    await rpc("ai_batch_close", { p_id: b.id, p_result: result });
    out.push({ batch: b.id, kind: b.kind, status: "ended", ...result });
  }
  return { ok: true, batches: out };
}
