// Calibragem dos atendentes com Claude: nota de 0 a 10 em 8 critérios.
// 7 critérios são avaliados pela IA a partir das mensagens do atendente no período (com a mensagem anterior
// como contexto); "Velocidade de resposta" é calculada a partir do tempo de resposta e do SLA.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = () => process.env.ANTHROPIC_CALIBRATION_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export const CRITERIA = [
  { key: "ortografia", label: "Ortografia", desc: "Escrita correta: ortografia, acentuação, concordância, pontuação e digitação. Abreviações de internet (vc, pq, tb) e erros recorrentes baixam a nota." },
  { key: "vicios_linguagem", label: "Vícios de linguagem", desc: "Ausência de vícios: gerundismo (\"vou estar verificando\"), diminutivos excessivos (\"minutinho\", \"rapidinho\"), muletas (\"tipo\", \"então\", \"né\"), excesso de \"kkk\"/emojis, repetição de frases prontas, \"infelizmente\" em excesso. Nota alta = linguagem limpa." },
  { key: "seguranca_autoridade", label: "Segurança e autoridade", desc: "Passa confiança: afirma com clareza, explica o porquê, orienta o cliente, assume a condução. Hesitação (\"acho que\", \"não sei\", \"vou ver se dá\"), transferir responsabilidade ou pedir desculpas em excesso baixam a nota." },
  { key: "energia_entusiasmo", label: "Energia e entusiasmo", desc: "Tom cordial, positivo e engajado, que demonstra vontade de ajudar. Respostas secas, monossilábicas, frias ou burocráticas baixam a nota (sem confundir entusiasmo com excesso de emojis)." },
  { key: "resolucao", label: "Resolução", desc: "Efetividade: resolve a demanda, entrega o que prometeu, volta com a solução, fecha o assunto. \"Vou verificar\" sem retorno, respostas que não respondem e promessas não cumpridas baixam a nota." },
  { key: "comunicacao_ativa", label: "Comunicação ativa x passiva", desc: "Ativa = toma iniciativa: puxa conversa com o cliente, dá retorno sem ser cobrado, antecipa problemas, avisa andamento, faz perguntas para entender a necessidade, sugere próximos passos. Passiva = só reage quando o cliente escreve. Use também o número de iniciativas informado." },
  { key: "conhecimento_marketing", label: "Conhecimento de marketing", desc: "Demonstra domínio de marketing: conteúdo, campanhas, redes sociais, público-alvo, posicionamento, métricas, sazonalidade; orienta e sugere com propriedade. Se o atendente nunca teve ocasião de mostrar esse conhecimento, marque evidence=false." },
];
export const SPEED = { key: "velocidade", label: "Velocidade de resposta" };

const SYSTEM = `Você é auditor(a) sênior de qualidade de atendimento de uma agência de marketing brasileira que atende
clientes em grupos de WhatsApp. Você faz a CALIBRAGEM de UM atendente: lê as mensagens que ele(a) escreveu no período
(cada uma acompanhada da mensagem anterior do grupo, para contexto) e dá uma nota de 0 a 10 em cada critério.

Escala: 0–3 crítico · 4–5 abaixo do esperado · 6–7 adequado · 8–9 muito bom · 10 exemplar. Use decimais (ex.: 7.5).
Seja justo e consistente entre atendentes: a nota precisa ser defensável com exemplos reais das mensagens.

Para cada critério devolva:
- "score": a nota.
- "evidence": false só quando as mensagens não dão base para avaliar o critério (aí a nota não entra na média).
- "comment": 1–2 frases explicando a nota.
- "examples": até 2 trechos curtos (até 120 caracteres) copiados das mensagens que justificam a nota. Vazio se não houver.
- "improve": uma orientação prática e específica para o atendente melhorar nesse critério.

Depois: "summary" (2–3 frases sobre o perfil do atendente), "strengths" (principais pontos fortes) e
"improve" (as 2–3 prioridades de desenvolvimento). Escreva em português do Brasil, em tom profissional e respeitoso.
Não avalie velocidade de resposta (é calculada à parte). Não invente fatos que não estão nas mensagens.`;

function schema() {
  const crit = {
    type: "object",
    additionalProperties: false,
    required: ["score", "evidence", "comment", "examples", "improve"],
    properties: {
      score: { type: "number" },
      evidence: { type: "boolean" },
      comment: { type: "string" },
      examples: { type: "array", items: { type: "string" } },
      improve: { type: "string" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "summary", "strengths", "improve"],
    properties: {
      criteria: {
        type: "object",
        additionalProperties: false,
        required: CRITERIA.map((c) => c.key),
        properties: Object.fromEntries(CRITERIA.map((c) => [c.key, crit])),
      },
      summary: { type: "string" },
      strengths: { type: "string" },
      improve: { type: "string" },
    },
  };
}

const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) * 10) / 10));
const fmtMin = (s) => (s == null ? "—" : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1).replace(".", ",")} h`);
const fmtTime = (iso) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

// Velocidade: 60% pelo % dentro do SLA + 40% pela mediana comparada ao SLA.
export function speedScore(resp) {
  if (!resp || !Number(resp.responses)) {
    return { score: null, evidence: false, comment: "Sem respostas a clientes no período.", examples: [], improve: "" };
  }
  const sla = Number(resp.sla_minutes || 15) * 60;
  const ratio = Number(resp.median_seconds) / sla;
  const medianPart = ratio <= 0.25 ? 10 : ratio >= 2 ? 0 : (10 * (2 - ratio)) / 1.75;
  const score = clamp(0.6 * (Number(resp.sla_pct) / 10) + 0.4 * medianPart);
  return {
    score,
    evidence: true,
    comment: `${String(resp.sla_pct).replace(".", ",")}% das ${resp.responses} respostas dentro do SLA de ${Math.round(sla / 60)} min; mediana ${fmtMin(Number(resp.median_seconds))}, 90% em até ${fmtMin(Number(resp.p90_seconds))}.`,
    examples: [],
    improve: score >= 8 ? "Manter o ritmo." : "Priorizar a primeira resposta rápida (mesmo que seja para dizer que já está cuidando) e acompanhar a fila de Aguardando resposta.",
  };
}

function buildParams(att, period) {
  const lines = att.messages.map((m) => {
    const prev = m.prev ? `   ↳ antes: ${m.prev.who === "cliente" ? "Cliente" : "Time"}: ${m.prev.text}` : "   ↳ (primeira mensagem do grupo)";
    return `[${fmtTime(m.at)} · ${m.grp}]\n${prev}\n   → ${att.name}: ${m.text}`;
  });
  const r = att.resp || {};
  const user = `Atendente: ${att.name}${att.area ? ` (${att.area})` : ""}
Período: ${fmtTime(period.from)} a ${fmtTime(period.to)}
Números: ${att.msgs} mensagens em ${att.groups} grupos · ${r.responses ?? 0} respostas a clientes · ${att.initiatives} iniciativas (mensagens que puxaram ou retomaram a conversa sem o cliente ter escrito antes)

Critérios:
${CRITERIA.map((c) => `- ${c.key} — ${c.label}: ${c.desc}`).join("\n")}

Mensagens do atendente (até ${att.messages.length} mais recentes, em ordem cronológica):
${lines.join("\n")}`;
  return {
    model: MODEL(),
    max_tokens: 6000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: schema() } },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  };
}

export function parseCalibration(message, meta, batchId) {
  if (message.stop_reason === "refusal") throw new Error("Calibragem recusada pelo modelo");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Resposta sem texto (stop_reason=${message.stop_reason})`);
  const out = JSON.parse(text);
  const scores = {};
  for (const c of CRITERIA) {
    const v = out.criteria?.[c.key] || {};
    scores[c.key] = { score: clamp(v.score), evidence: v.evidence !== false, comment: v.comment || "", examples: (v.examples || []).slice(0, 2), improve: v.improve || "" };
  }
  scores[SPEED.key] = meta.speed;
  const valid = Object.values(scores).filter((s) => s.evidence && s.score != null).map((s) => s.score);
  return {
    attendant_id: meta.attendant_id,
    period_from: meta.period_from,
    period_to: meta.period_to,
    overall: valid.length ? clamp(valid.reduce((a, b) => a + b, 0) / valid.length) : null,
    scores,
    summary: out.summary,
    strengths: out.strengths,
    improve: out.improve,
    metrics: meta.metrics,
    model: message.model,
    batch_id: batchId,
  };
}

// Envia um lote com um pedido por atendente que escreveu pelo menos 5 mensagens nos últimos `days` dias.
export async function submitCalibrationBatch(rpc, { days = 30 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  const open = (await rpc("ai_batch_open", { p_kind: "calibragem" })) ?? [];
  if (open.length) return { ok: true, submitted: 0, skipped: "já existe uma calibragem em andamento", batch: open[0].id };
  const cand = await rpc("ai_calibration_candidates", { p_days: days });
  const items = cand?.items ?? [];
  if (!items.length) return { ok: true, submitted: 0, skipped: "nenhum atendente com mensagens suficientes no período" };
  const period = { from: cand.from, to: cand.to };
  const metas = {};
  const requests = items.map((att) => {
    metas[att.id] = {
      attendant_id: att.id,
      name: att.name,
      period_from: cand.from,
      period_to: cand.to,
      speed: speedScore(att.resp),
      metrics: { msgs: att.msgs, groups: att.groups, initiatives: att.initiatives, ...(att.resp || {}) },
    };
    return { custom_id: att.id, params: buildParams(att, period) };
  });
  const batch = await new Anthropic().messages.batches.create({ requests });
  await rpc("ai_batch_create", { p_id: batch.id, p_rosters: metas, p_kind: "calibragem" });
  return { ok: true, submitted: requests.length, batch: batch.id };
}
