// Revisão de casos com Claude: decide se cada atendimento está aberto ou encerrado.
// Metodologia (resumo):
//   1. Qual era a demanda do cliente? (pergunta, pedido, problema, aviso)
//   2. Ela foi atendida? Quem deu a última palavra e o que ela diz?
//   3. Encerrado pelo CLIENTE: agradeceu/confirmou que deu certo/disse que não precisa mais.
//      Encerrado pela EQUIPE: entregou o pedido ou respondeu por completo e o cliente não trouxe nova demanda.
//      SEM DEMANDA: só aviso, cortesia, envio de arquivo/informação que não pede ação.
//      ABERTO: pergunta sem resposta, pedido sem confirmação, "vou verificar" sem retorno, reclamação sem solução,
//      ou o time pediu algo ao cliente e ele não respondeu (próximo passo = cliente).
//   4. Confiança: alta (evidência explícita), média (forte indício), baixa (ambíguo → mantém aberto).
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, buildTranscript } from "./analyze.mjs";

const SYSTEM = `Você revisa casos de atendimento ao cliente em grupos de WhatsApp de uma agência de marketing brasileira.
Cada grupo reúne o cliente e o time da agência. Você recebe UM atendimento e decide se o caso está ABERTO ou ENCERRADO,
para o time poder fechar o que já foi resolvido e focar no que falta.

Siga esta metodologia, nesta ordem:
1. Identifique a demanda do cliente: pergunta, pedido, problema/reclamação ou apenas aviso/informação.
2. Veja se a demanda foi atendida e quem deu a última palavra relevante. Considere o tempo desde a última mensagem.
3. Classifique:
   - ENCERRADO pelo "cliente": o cliente agradeceu de forma conclusiva, confirmou que deu certo/recebeu, disse que não
     precisa mais ou encerrou o assunto ("perfeito, obrigado", "deu certo", "recebido", "pode desconsiderar").
   - ENCERRADO pela "equipe": o time entregou o que foi pedido (enviou arquivo, link, acesso, orçamento, confirmou que
     executou) ou respondeu a dúvida por completo, e o cliente não trouxe demanda nova depois. Silêncio do cliente por
     mais de 1 dia útil após uma entrega completa também conta como encerrado pela equipe.
   - ENCERRADO "sem_demanda": não havia nada a fazer — só cumprimento, aviso, compartilhamento de material, conversa
     interna entre pessoas do cliente, ou mensagem informativa que não pede ação nem confirmação.
   - ABERTO: existe pergunta sem resposta; pedido sem confirmação de que foi feito; o time disse "vou verificar",
     "estamos vendo", "já retorno" e não voltou com solução; reclamação ou problema sem solução; reunião/prazo combinado
     ainda pendente; ou o time pediu algo ao cliente e aguarda (nesse caso, próximo passo = "cliente").
4. Confiança: "alta" quando há evidência explícita na conversa; "media" quando o indício é forte; "baixa" quando é
   ambíguo (áudio sem transcrição, imagem sem contexto). Na dúvida, mantenha ABERTO.

Regras de saída:
- "next_step": "equipe" se o time precisa agir, "cliente" se o time aguarda o cliente, "ninguem" se encerrado.
- "closed_by": só quando encerrado ("cliente", "equipe" ou "sem_demanda"); use "nenhum" quando aberto.
- "reason": uma frase curta (até 160 caracteres) explicando a decisão, citando o que falta ou o que encerrou.
- "evidence": trecho curto da mensagem que comprova a decisão (até 120 caracteres), ou "" se não houver.
Não invente fatos que não estão na conversa.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["demand", "status", "closed_by", "next_step", "confidence", "reason", "evidence"],
  properties: {
    demand: { type: "string", enum: ["pergunta", "pedido", "problema", "aviso", "nenhuma"] },
    status: { type: "string", enum: ["aberto", "encerrado"] },
    closed_by: { type: "string", enum: ["cliente", "equipe", "sem_demanda", "nenhum"] },
    next_step: { type: "string", enum: ["equipe", "cliente", "ninguem"] },
    confidence: { type: "string", enum: ["alta", "media", "baixa"] },
    reason: { type: "string" },
    evidence: { type: "string" },
  },
};

const hoursAgo = (iso) => Math.round((Date.now() - new Date(iso)) / 36e5);

export function buildCaseParams(conv, model = process.env.ANTHROPIC_CASE_MODEL || DEFAULT_MODEL) {
  const { transcript } = buildTranscript(conv);
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  const user = `Produto/número monitorado: ${conv.instance_name}
Grupo: ${conv.group_name}
Agora: ${agora} (horário de Brasília). Última mensagem há ${hoursAgo(conv.last_message_at)} hora(s).
${conv.waiting ? "O sistema marca este grupo como aguardando resposta do time." : "O sistema não marca espera de resposta neste grupo."}

Transcrição:
${transcript}`;
  return {
    model,
    max_tokens: 1500,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  };
}

export function parseCaseDecision(message) {
  if (message.stop_reason === "refusal") throw new Error("Revisão recusada pelo modelo");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Resposta sem texto (stop_reason=${message.stop_reason})`);
  const d = JSON.parse(text);
  if (d.status === "aberto") d.closed_by = "nenhum";
  if (d.status === "encerrado") d.next_step = "ninguem";
  return d;
}

// Envia UM lote com os casos abertos que tiveram novidade desde a última revisão.
export async function submitCaseBatch(rpc, { limit = 1000, days = 30 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  }
  const open = (await rpc("ai_batch_open", { p_kind: "casos" })) ?? [];
  if (open.length) return { ok: true, submitted: 0, skipped: "já existe uma revisão em andamento", batch: open[0].id };
  const items = (await rpc("ai_case_candidates", { p_limit: limit, p_days: days })) ?? [];
  if (!items.length) return { ok: true, submitted: 0 };
  const ids = {};
  const requests = items.map((conv) => {
    ids[conv.id] = true;
    return { custom_id: conv.id, params: buildCaseParams(conv) };
  });
  const batch = await new Anthropic().messages.batches.create({ requests });
  await rpc("ai_batch_create", { p_id: batch.id, p_rosters: ids, p_kind: "casos" });
  return { ok: true, submitted: requests.length, batch: batch.id };
}
