// Análise de atendimentos com Claude: categoria, sentimento, resolução, qualidade do time, FAQ.
import Anthropic from "@anthropic-ai/sdk";

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

export async function analyzeConversation(client, conv, categories, model = DEFAULT_MODEL) {
  const { transcript, roster } = buildTranscript(conv);
  const user = `Produto/número monitorado: ${conv.instance_name}
Grupo: ${conv.group_name}
Categorias permitidas: ${categories.join(" | ")}
Integrantes do time nesta conversa: ${roster.map((r) => `[${r.code}] ${r.name}`).join(", ") || "nenhum (time não respondeu)"}

Transcrição:
${transcript}`;

  const response = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: schema(categories) } },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") throw new Error("Análise recusada pelo modelo");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Resposta sem texto (stop_reason=${response.stop_reason})`);
  const out = JSON.parse(text);

  out.team_feedback = (out.team_feedback || []).map((f) => {
    const r = roster.find((x) => x.code === f.code);
    return { ...f, attendant_id: r?.attendant_id ?? null, name: r?.name ?? f.code };
  });
  out.quality_score = Math.max(0, Math.min(10, Number(out.quality_score) || 0));
  return { analysis: out, model: response.model };
}

// Busca atendimentos pendentes, analisa e salva. `rpc(fn, args)` vem do Supabase (service role).
export async function runAnalysisBatch(rpc, { limit = 15, idleMinutes = 60, concurrency = 4 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  }
  const client = new Anthropic();
  const pending = await rpc("ai_pending_conversations", { p_limit: limit, p_idle_minutes: idleMinutes });
  const items = pending?.items ?? [];
  const categories = pending?.categories?.length ? pending.categories : ["Outros"];
  if (!categories.includes("Outros")) categories.push("Outros");

  let done = 0;
  const errors = [];
  const queue = [...items];
  async function worker() {
    while (queue.length) {
      const conv = queue.shift();
      try {
        const { analysis, model } = await analyzeConversation(client, conv, categories);
        await rpc("ai_save_analysis", { p_conversation: conv.id, p: analysis, p_model: model });
        done += 1;
      } catch (e) {
        errors.push(`${conv.group_name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ok: true, found: items.length, analyzed: done, errors };
}
