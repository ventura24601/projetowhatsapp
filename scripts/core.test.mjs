// Testes da lógica SQL (ingestão Z-API → tempo de resposta) usando PGlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalDb, asUser, rpc, DEMO_USER } from "./pg-local.mjs";

const GROUP = "120363000000000001-group";
let seq = 0;

// Gera um payload no formato do webhook "Ao receber" da Z-API.
function zapi({ at, from = "cliente", text = "Olá", phone = "5511911112222", lid, group = GROUP, extra = {} }) {
  seq += 1;
  return {
    type: "ReceivedCallback",
    messageId: `MSG${seq}`,
    isGroup: true,
    fromMe: from === "supervisor",
    phone: group,
    chatName: "Cliente Teste",
    participantPhone: from === "supervisor" ? null : phone,
    participantLid: lid ?? null,
    connectedPhone: "5511900000000",
    senderName: from === "supervisor" ? "Supervisor" : "Fulano",
    momment: new Date(at).getTime(),
    text: { message: text },
    ...extra,
  };
}

async function setup() {
  const db = await createLocalDb();
  await asUser(db, DEMO_USER);
  const me = await rpc(db, "whoami");
  assert.equal(me.role, "admin");
  // expediente 24x7 para facilitar as contas, SLA 15 min
  await rpc(db, "save_settings", {
    p: { business_days: [1, 2, 3, 4, 5, 6, 7], business_start: "00:00", business_end: "23:59:59", default_sla_minutes: 15 },
  });
  const secret = (await db.query(`select webhook_secret from instances where slug = 'black'`)).rows[0].webhook_secret;
  const send = (p, slug = "black", s = secret) => rpc(db, "ingest_zapi", { p_slug: slug, p_secret: s, p });
  return { db, send, secret };
}

test("webhook rejeita segredo errado e ignora mensagens fora de grupo", async () => {
  const { send } = await setup();
  assert.equal((await send(zapi({ at: "2026-11-10T12:00:00Z" }), "black", "errado")).status, 401);
  assert.equal((await send(zapi({ at: "2026-11-10T12:00:00Z" }), "nao-existe")).status, 404);
  assert.equal((await send({ ...zapi({ at: "2026-11-10T12:00:00Z" }), isGroup: false })).skipped, "not_group");
  assert.equal((await send({ ...zapi({ at: "2026-11-10T12:00:00Z" }), type: "MessageStatusCallback" })).skipped, "type:MessageStatusCallback");
});

test("calcula tempo de resposta do atendente cadastrado e do supervisor", async () => {
  const { db, send } = await setup();
  await rpc(db, "save_attendant", { p: { name: "Ana", phone: "(11) 98888-7777", products: ["black"] } });

  await send(zapi({ at: "2026-11-10T12:00:00Z", text: "Bom dia, a tela está apagada" }));
  await send(zapi({ at: "2026-11-10T12:02:00Z", text: "Alguém?" }));
  // atendente responde com número sem o 9 e com 55 — deve casar mesmo assim
  const r = await send(zapi({ at: "2026-11-10T12:10:00Z", from: "atendente", phone: "551188887777", text: "Oi! Vou verificar" }));
  assert.equal(r.author, "atendente");

  // "obrigado" do cliente não abre nova espera
  await send(zapi({ at: "2026-11-10T12:11:00Z", text: "Obrigado!" }));
  // nova pergunta → supervisor responde 30 min depois (estoura SLA de 15)
  await send(zapi({ at: "2026-11-10T13:00:00Z", text: "E o relatório?" }));
  await send(zapi({ at: "2026-11-10T13:30:00Z", from: "supervisor", text: "Enviado" }));

  const ev = (await db.query(`select author_type, response_seconds, sla_breached, is_first_response from response_events order by responded_at`)).rows;
  assert.deepEqual(ev, [
    { author_type: "atendente", response_seconds: 600, sla_breached: false, is_first_response: true },
    { author_type: "supervisor", response_seconds: 1800, sla_breached: true, is_first_response: false },
  ]);

  const ov = await rpc(db, "dash_overview", { p_instance: "black", p_from: "2026-11-10T00:00:00Z", p_to: "2026-11-11T00:00:00Z" });
  assert.equal(Number(ov.kpis.responses), 2);
  assert.equal(Number(ov.kpis.sla_pct), 50);
  assert.equal(Number(ov.kpis.median_seconds), 1200);
  assert.equal(Number(ov.kpis.customer_msgs), 4);

  const team = await rpc(db, "dash_team", { p_instance: "black", p_from: "2026-11-10T00:00:00Z", p_to: "2026-11-11T00:00:00Z" });
  const ana = team.find((t) => t.name === "Ana");
  assert.equal(Number(ana.responses), 1);
  assert.equal(Number(ana.median_seconds), 600);
});

test("duplicatas são ignoradas e pendências aparecem", async () => {
  const { db, send } = await setup();
  const p = zapi({ at: new Date(Date.now() - 40 * 60e3).toISOString(), text: "Preciso de ajuda" });
  await send(p);
  assert.equal((await send(p)).duplicate, true);
  const pend = await rpc(db, "dash_pending", { p_instance: null });
  assert.equal(pend.length, 1);
  assert.equal(pend[0].breached, true);
  assert.equal(pend[0].first_message, "Preciso de ajuda");
  await rpc(db, "resolve_waiting", { p_group: pend[0].group_id });
  assert.equal((await rpc(db, "dash_pending", { p_instance: null })).length, 0);
});

test("cadastrar atendente depois reprocessa o histórico do grupo", async () => {
  const { db, send } = await setup();
  await send(zapi({ at: "2026-11-10T12:00:00Z", text: "Oi, problema no player" }));
  await send(zapi({ at: "2026-11-10T12:05:00Z", phone: "5521977776666", text: "Olá, já vejo" }));
  assert.equal(Number((await db.query(`select count(*) n from response_events`)).rows[0].n), 0);

  const unknown = await rpc(db, "unknown_senders", { p_instance: null, p_days: 3650 });
  assert.ok(unknown.some((u) => u.key === "2177776666"));

  const saved = await rpc(db, "save_attendant", { p: { name: "Bruno", phone: "21 97777-6666" } });
  assert.equal(saved.affected_groups.length, 1);
  await rpc(db, "admin_rebuild_group", { p_group: saved.affected_groups[0] });
  const ev = (await db.query(`select response_seconds from response_events`)).rows;
  assert.deepEqual(ev, [{ response_seconds: 300 }]);
});

test("horário comercial: mensagem fora do expediente conta a partir da abertura", async () => {
  const { db, send } = await setup();
  await rpc(db, "save_settings", {
    p: { business_days: [1, 2, 3, 4, 5], business_start: "08:00", business_end: "18:00", use_business_hours: true },
  });
  await rpc(db, "save_attendant", { p: { name: "Ana", phone: "11988887777" } });
  // terça 10/11/2026 21:00 BRT (00:00Z do dia 11) → resposta quarta 08:20 BRT (11:20Z)
  await send(zapi({ at: "2026-11-11T00:00:00Z", text: "Tela travou" }));
  await send(zapi({ at: "2026-11-11T11:20:00Z", from: "atendente", phone: "11988887777", text: "Bom dia, verificando" }));
  const ev = (await db.query(`select response_seconds, business_seconds, sla_breached from response_events`)).rows[0];
  assert.equal(ev.business_seconds, 20 * 60);
  assert.equal(ev.sla_breached, true); // 20 min > 15 min
  // o atendimento não foi quebrado pela madrugada
  assert.equal(Number((await db.query(`select count(*) n from conversations`)).rows[0].n), 1);
});

test("viewer não pode alterar cadastros", async () => {
  const { db } = await setup();
  await asUser(db, { id: "00000000-0000-4000-8000-000000000002", email: "viewer@demo.local" });
  assert.equal((await rpc(db, "whoami")).role, "viewer");
  await assert.rejects(rpc(db, "save_attendant", { p: { name: "X", phone: "11999990000" } }), /administradores/);
  await asUser(db, null);
  await assert.rejects(rpc(db, "dash_pending", { p_instance: null }), /login/);
});

test("análise de IA é salva e aparece nos insights", async () => {
  const { db, send } = await setup();
  await rpc(db, "save_attendant", { p: { name: "Ana", phone: "11988887777" } });
  await send(zapi({ at: "2026-11-10T12:00:00Z", text: "Quero cancelar" }));
  await send(zapi({ at: "2026-11-10T12:03:00Z", from: "atendente", phone: "11988887777", text: "Entendo, vamos conversar" }));
  const pending = await rpc(db, "ai_pending_conversations", { p_limit: 10, p_idle_minutes: 0 });
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].messages.length, 2);
  const attId = pending.items[0].messages[1].attendant_id;
  await rpc(db, "ai_save_analysis", {
    p_conversation: pending.items[0].id,
    p_model: "teste",
    p: {
      category: "Cancelamento", sentiment: "negativo", satisfaction: 2, quality_score: 8, resolved: false,
      pending_on: "equipe", summary: "Cliente quer cancelar", topics: ["cancelamento"],
      customer_questions: ["Como cancelo?"], issues: [],
      team_feedback: [{ attendant_id: attId, name: "Ana", score: 8, strengths: "Empatia", improve: "Prazo" }],
    },
  });
  const ins = await rpc(db, "dash_insights", { p_instance: null, p_from: "2026-11-10T00:00:00Z", p_to: "2026-11-11T00:00:00Z" });
  assert.equal(Number(ins.analyzed), 1);
  assert.equal(ins.categories[0].category, "Cancelamento");
  assert.equal(Number(ins.team_feedback[0].score), 8);
  // reprocessar o grupo preserva a análise
  const gid = (await db.query(`select id from groups`)).rows[0].id;
  await rpc(db, "admin_rebuild_group", { p_group: gid });
  assert.equal((await db.query(`select category from conversations`)).rows[0].category, "Cancelamento");
});
