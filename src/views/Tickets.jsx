import { useState } from "react";
import { rpc } from "../api.js";
import { ago, fmtDateTime, fmtNum } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, Pill, Seg, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

export const PRODUCT = {
  discador: "Discador",
  appcrc: "APPCRC",
  whatsapp_oficial: "WhatsApp Oficial / API",
  ramal: "Ramal",
  tecnico: "Problema técnico",
};
const STATUS = {
  aberto: { label: "Aberto", cls: "p-r" },
  andamento: { label: "Em andamento", cls: "p-a" },
  resolvido: { label: "Resolvido", cls: "p-g" },
  descartado: { label: "Descartado", cls: "p-n" },
};
const SOURCE = { auto: "aberto automaticamente", ia: "aberto pela IA", manual: "aberto manualmente" };
const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function Tickets({ ctx }) {
  const data = useData(() => rpc("dash_tickets", { p_instance: ctx.inst || null }), [ctx.inst], { refreshMs: 60000 });
  const [filter, setFilter] = useState("pendentes");
  const [product, setProduct] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const c = data.data?.counts || {};
  const all = data.data?.items || [];

  const terms = norm(q).split(/\s+/).filter(Boolean);
  const shown = all.filter((t) =>
    (filter === "pendentes" ? ["aberto", "andamento"].includes(t.status) : filter === "todos" || t.status === filter)
    && (!product || t.product === product)
    && terms.every((w) => norm([t.group_name, t.customer_name, t.trigger_text, t.summary, t.assignee, t.instance_name, `#${t.number}`].join(" ")).includes(w)));

  async function set(t, status, ask) {
    let note = null;
    if (ask) {
      note = prompt(ask, t.note || "");
      if (note === null) return;
    }
    setBusy(t.id);
    setErr(null);
    try {
      await rpc("ticket_set", { p_id: t.id, p_status: status, p_note: note });
      await data.reload();
      ctx.reloadTickets?.();
    } catch (e) {
      setErr(e);
    }
    setBusy(null);
  }

  return (
    <div className="stack">
      <ErrorBox error={data.error || err} />
      <p className="note">
        Chamados para a equipe interna. Abrem <b>sozinhos</b> quando o cliente fala de Discador, APPCRC, WhatsApp Oficial /
        API Oficial / ZapIcom, ramal (extra, em inglês…) ou relata problema técnico (“não está funcionando”, “erro”,
        “caiu”…). Assuntos de Facebook e Google ficam de fora. A revisão diária da IA (7h) também abre chamados que as
        palavras-chave não pegaram e escreve um resumo do problema. Novas mensagens do mesmo grupo somam no chamado aberto.
      </p>
      <div className="kpis">
        <div className={`kpi ${c.aberto ? "bad" : "good"}`}><span className="kpi-l">Abertos</span><strong className="kpi-v">{fmtNum(c.aberto ?? 0)}</strong></div>
        <div className={`kpi ${c.andamento ? "warn" : ""}`}><span className="kpi-l">Em andamento</span><strong className="kpi-v">{fmtNum(c.andamento ?? 0)}</strong></div>
        <div className="kpi good"><span className="kpi-l">Resolvidos (7 dias)</span><strong className="kpi-v">{fmtNum(c.resolvido7 ?? 0)}</strong></div>
        <div className="kpi"><span className="kpi-l">Tempo para resolver (mediana, 30d)</span><strong className="kpi-v">{c.resolve_hours == null ? "—" : `${String(c.resolve_hours).replace(".", ",")} h`}</strong></div>
      </div>
      <Card
        title="Chamados"
        hint="Abertos primeiro. Clique em Ver conversa para entender o contexto."
        action={
          <div className="row wrap">
            <input className="input search" placeholder="Buscar grupo, cliente, texto, nº…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Todos os assuntos</option>
              {Object.entries(PRODUCT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <Seg
              value={filter}
              onChange={setFilter}
              options={[
                { value: "pendentes", label: "Pendentes" },
                { value: "aberto", label: "Abertos" },
                { value: "andamento", label: "Em andamento" },
                { value: "resolvido", label: "Resolvidos" },
                { value: "descartado", label: "Descartados" },
                { value: "todos", label: "Todos" },
              ]}
            />
          </div>
        }
      >
        {shown.length === 0 ? (
          <Empty>{data.loading ? "Carregando…" : filter === "pendentes" && !q && !product ? "Nenhum chamado pendente. ✅" : "Nenhum chamado com esses filtros."}</Empty>
        ) : (
          <div className="alerts">
            {shown.map((t) => (
              <article key={t.id} className={`alert tk-${t.status}`}>
                <header className="row between wrap">
                  <div className="row wrap">
                    <Pill cls={STATUS[t.status].cls}>{STATUS[t.status].label}</Pill>
                    <span className="mono sub">#{t.number}</span>
                    <b className="alert-g">{t.group_name}</b>
                    <InstanceTag name={t.instance_name} color={t.instance_color} />
                    <Pill cls="p-b">{PRODUCT[t.product] || t.product}</Pill>
                  </div>
                  <span className="sub">
                    {SOURCE[t.source]} {ago(t.opened_at)}
                    {t.mentions > 1 && ` · ${t.mentions} menções`}
                    {t.assignee && t.status === "andamento" && ` · com ${t.assignee}`}
                  </span>
                </header>
                {t.summary && <p className="alert-txt"><b>Resumo:</b> {t.summary}</p>}
                <p className="tk-quote">“{t.trigger_text}”{t.customer_name && <span className="sub"> — {t.customer_name}, {fmtDateTime(t.opened_at)}</span>}</p>
                {t.last_customer_text && t.last_customer_text !== t.trigger_text && t.mentions > 1 && (
                  <p className="sub">Última do cliente ({ago(t.last_mention_at)}): {t.last_customer_text}</p>
                )}
                {t.closed_at && (
                  <p className="sub">{t.status === "resolvido" ? "✔ Resolvido" : "Descartado"} {ago(t.closed_at)}{t.closed_by && ` por ${t.closed_by}`}{t.note && ` — “${t.note}”`}</p>
                )}
                {!t.closed_at && t.note && <p className="sub">Nota: {t.note}</p>}
                <div className="row wrap">
                  <button className="btn small" onClick={() => setOpen(t)}>Ver conversa</button>
                  {t.status === "aberto" && <button className="btn small ghost" disabled={busy === t.id} onClick={() => set(t, "andamento")}>Assumir</button>}
                  {["aberto", "andamento"].includes(t.status) && (
                    <>
                      <button className="btn small ghost" disabled={busy === t.id} onClick={() => set(t, "resolvido", "O que foi feito? (opcional)")}>Resolver</button>
                      <button className="btn small ghost" disabled={busy === t.id} onClick={() => set(t, "descartado", "Por que não é um chamado? (opcional)")}>Não é chamado</button>
                    </>
                  )}
                  {["resolvido", "descartado"].includes(t.status) && (
                    <button className="btn small ghost" disabled={busy === t.id} onClick={() => set(t, "aberto")}>Reabrir</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
      {open && <Thread conversationId={open.conversation_id} groupId={open.group_id} title={open.group_name} onClose={() => setOpen(null)} />}
    </div>
  );
}
