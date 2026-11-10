// Relatório para gestores, enviado ao webhook do n8n.
//  11h ("manha"): resumo rápido do dia anterior + o que está aberto e mais urgente agora.
//  15h ("tarde"): o que entrou desde as 11h e ainda não foi fechado, por urgência.
const TZ = "America/Sao_Paulo";
const OFFSET = "-03:00"; // Brasília (sem horário de verão)
const MAX_ITEMS = 10;

const ymd = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
const dm = (d) => new Date(d).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const hm = (d) => new Date(d).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const at = (day, time) => new Date(`${day}T${time}${OFFSET}`);
const num = (n) => Number(n ?? 0).toLocaleString("pt-BR");

function dur(sec) {
  if (sec == null) return "—";
  const m = Math.round(Number(sec) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function since(iso) {
  return dur((Date.now() - new Date(iso)) / 1000);
}

const CLOSED = { cliente: "pelo cliente", equipe: "pela equipe", sem_demanda: "sem demanda", manual: "manual" };

function instanceLines(rows) {
  return rows.map((i) => {
    const k = i.kpis || {};
    const closed = Object.values(i.closed || {}).reduce((a, b) => a + Number(b), 0);
    return `• *${i.name}*: ${num(k.responses)} respostas · mediana ${dur(k.median_seconds)} · ${k.sla_pct == null ? "—" : `${String(k.sla_pct).replace(".", ",")}%`} no SLA (${num(k.breached)} fora) · ${num(i.customer_msgs)} msgs de clientes em ${num(i.active_groups)} grupos · ${num(closed)} casos encerrados`;
  });
}

function waitingLines(rows) {
  return rows.slice(0, MAX_ITEMS).map((w) => {
    const late = w.breached ? "🔴" : "🟡";
    const msg = w.reason || (w.first_message ? `“${w.first_message}”` : "");
    return `${late} *${w.group_name}* (${w.instance_name}) — esperando há ${dur(w.eff_seconds)} (horário comercial)${w.unanswered > 1 ? ` · ${w.unanswered} msgs` : ""}${w.owner_name ? ` · resp.: ${w.owner_name}` : ""}\n   ${msg}`;
  });
}

function caseLines(rows) {
  return rows.slice(0, MAX_ITEMS).map((c) => {
    const tags = [
      ["negativo", "irritado"].includes(c.sentiment) ? "cliente insatisfeito" : null,
      c.holding ? "“vou verificar” sem retorno" : null,
      c.waiting ? "sem resposta" : null,
    ].filter(Boolean);
    return `• *${c.group_name}* (${c.instance_name}) — última msg há ${since(c.last_message_at)}${tags.length ? ` · ${tags.join(", ")}` : ""}\n   ${c.reason || c.summary || "Ainda não revisado pela IA"}`;
  });
}

export async function buildReport(rpc, kind, now = new Date()) {
  const today = ymd(now);
  let from;
  let to;
  let title;
  if (kind === "manha") {
    const y = new Date(at(today, "12:00:00").getTime() - 864e5);
    from = at(ymd(y), "00:00:00");
    to = at(today, "00:00:00");
    title = `Relatório de atendimento — 11h — resumo de ${dm(from)}`;
  } else {
    from = at(today, "11:00:00");
    to = now;
    title = `Relatório de atendimento — 15h — desde as 11h de ${dm(now)}`;
  }

  const d = await rpc("mgr_report", { p_since: from.toISOString(), p_until: to.toISOString() });
  const waiting = d.waiting || [];
  const breached = waiting.filter((w) => w.breached);
  let open = d.open_cases || [];
  if (kind === "tarde") open = open.filter((c) => c.new_in_period);
  const urgentOpen = open.filter((c) => !c.waiting); // os sem resposta já aparecem na lista de espera
  const negative = d.negative || [];

  const lines = [`*${title}*`, ""];
  if (kind === "manha") {
    lines.push("*Ontem, em resumo*", ...instanceLines(d.by_instance || []));
    const closedAll = {};
    for (const i of d.by_instance || []) for (const [k, v] of Object.entries(i.closed || {})) closedAll[k] = (closedAll[k] || 0) + Number(v);
    const closedTxt = Object.entries(closedAll).map(([k, v]) => `${v} ${CLOSED[k] ?? k}`).join(" · ");
    if (closedTxt) lines.push(`• Casos encerrados: ${closedTxt}`);
    if (negative.length) lines.push(`• ${negative.length} atendimento(s) com cliente insatisfeito`);
    lines.push("");
  } else {
    const k = (d.by_instance || []).reduce((a, i) => ({ r: a.r + Number(i.kpis?.responses || 0), b: a.b + Number(i.kpis?.breached || 0), m: a.m + Number(i.customer_msgs || 0) }), { r: 0, b: 0, m: 0 });
    lines.push(`Desde as 11h: ${num(k.m)} mensagens de clientes, ${num(k.r)} respostas do time, ${num(k.b)} fora do SLA.`, "");
  }

  lines.push(`*Aguardando resposta agora: ${waiting.length}* (${breached.length} fora do SLA)`);
  lines.push(...(waitingLines(waiting).length ? waitingLines(waiting) : ["Nenhum grupo esperando resposta. ✅"]));
  if (waiting.length > MAX_ITEMS) lines.push(`… e mais ${waiting.length - MAX_ITEMS}.`);
  lines.push("");

  lines.push(kind === "manha"
    ? `*Casos abertos que o time precisa resolver: ${open.length}*`
    : `*Casos que surgiram desde as 11h e seguem abertos: ${open.length}*`);
  if (open.length > urgentOpen.length) lines.push(`(${open.length - urgentOpen.length} deles estão na lista de espera acima)`);
  lines.push(...(caseLines(urgentOpen).length ? caseLines(urgentOpen) : open.length ? [] : ["Nenhum caso aberto pendente com o time. ✅"]));
  if (urgentOpen.length > MAX_ITEMS) lines.push(`… e mais ${urgentOpen.length - MAX_ITEMS}.`);

  if (negative.length) {
    lines.push("", "*Clientes insatisfeitos*");
    for (const n of negative.slice(0, 5)) lines.push(`• *${n.group_name}* (${n.instance_name}) — ${n.summary || n.sentiment}${n.case_status === "encerrado" ? " (caso encerrado)" : ""}`);
  }
  lines.push("", `Gerado às ${hm(now)} · ${process.env.URL || "icomtv-monitor-atendimento-wa.netlify.app"}`);

  return {
    type: "relatorio_atendimento",
    kind,
    title,
    generated_at: now.toISOString(),
    period: { from: from.toISOString(), to: to.toISOString() },
    counts: { waiting: waiting.length, waiting_breached: breached.length, open_cases: open.length, negative: negative.length },
    text: lines.join("\n"),
    data: { by_instance: d.by_instance, waiting: waiting.slice(0, 30), open_cases: open.slice(0, 30), negative: negative.slice(0, 20) },
  };
}

export async function sendReport(rpc, kind, { test = false, url = process.env.REPORT_WEBHOOK_URL } = {}) {
  if (!url) return { ok: false, error: "REPORT_WEBHOOK_URL não configurada" };
  const report = await buildReport(rpc, kind);
  if (test) {
    report.test = true;
    report.title = `[TESTE] ${report.title}`;
    report.text = `*[TESTE]* ${report.text}`;
  }
  let status = null;
  let error = null;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
    status = r.status;
    if (!r.ok) error = (await r.text()).slice(0, 300);
  } catch (e) {
    error = e.message;
  }
  await rpc("report_log_add", { p_kind: kind, p_from: report.period.from, p_to: report.period.to, p_test: test, p_status: status, p_error: error });
  return { ok: !error, status, error, title: report.title, counts: report.counts };
}
