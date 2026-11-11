import { useState } from "react";
import { rpc, calibrateNow } from "../api.js";
import { ago, fmtDur, fmtNum, fmtPct } from "../lib/format.js";
import { Card, Empty, ErrorBox, Modal, useData } from "../components/ui.jsx";

const CRIT = [
  { key: "ortografia", label: "Ortografia", short: "Ortog.", hint: "Forma de escrita: ortografia, acentuação, concordância e digitação" },
  { key: "vicios_linguagem", label: "Vícios de linguagem", short: "Vícios", hint: "Gerundismo, diminutivos, muletas, excesso de “kkk”/emojis, frases prontas" },
  { key: "seguranca_autoridade", label: "Segurança e autoridade", short: "Segur.", hint: "Passa confiança, explica, conduz o cliente" },
  { key: "energia_entusiasmo", label: "Energia e entusiasmo", short: "Energia", hint: "Tom cordial, positivo e engajado" },
  { key: "resolucao", label: "Resolução", short: "Resol.", hint: "Efetividade para resolver e entregar o que prometeu" },
  { key: "velocidade", label: "Velocidade de resposta", short: "Veloc.", hint: "Calculada: % no SLA (60%) + mediana comparada ao SLA (40%)" },
  { key: "comunicacao_ativa", label: "Comunicação ativa x passiva", short: "Ativa", hint: "Toma iniciativa, dá retorno sem ser cobrado, puxa conversa — ou só reage" },
  { key: "conhecimento_marketing", label: "Conhecimento de marketing", short: "Mkt", hint: "Domínio de marketing ao orientar e sugerir" },
];

const tone = (v) => (v == null ? "" : v >= 8 ? "good" : v >= 6 ? "warn" : "bad");
const fmtScore = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

function Score({ s, big }) {
  if (!s || s.evidence === false || s.score == null) return <span className="cal-s na" title="Sem evidência suficiente no período">—</span>;
  return <span className={`cal-s ${tone(s.score)} ${big ? "big" : ""}`}>{fmtScore(s.score)}</span>;
}

export default function Calibration({ ctx }) {
  const cal = useData(() => rpc("dash_calibration", { p_instance: ctx.inst }), [ctx.inst], { refreshMs: 120000 });
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const items = cal.data?.items || [];
  const batch = cal.data?.batch;
  const running = batch?.status === "open";

  const avg = (key) => {
    const v = items.map((i) => (key ? i.scores?.[key] : { score: i.overall, evidence: true })).filter((s) => s && s.evidence !== false && s.score != null).map((s) => Number(s.score));
    return v.length ? { score: v.reduce((a, b) => a + b, 0) / v.length, evidence: true } : null;
  };

  async function run() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await calibrateNow();
      setMsg(r.submitted ? `Calibragem de ${r.submitted} atendente(s) enviada. O resultado chega em alguns minutos.` : r.skipped || "Nada para calibrar.");
      cal.reload();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      <ErrorBox error={cal.error || err} />
      <p className="note">
        Nota de 0 a 10 de cada atendente em 8 critérios, dada pela IA lendo as mensagens dos últimos 30 dias (com a
        mensagem anterior de cada uma como contexto). A velocidade é calculada pelo tempo de resposta. A nota geral é a
        média dos critérios com evidência. Roda toda segunda-feira às 8h.
      </p>
      <Card
        title="Calibragem da equipe"
        hint={batch ? (running ? `Calibragem em andamento (${batch.count} atendentes, enviada ${ago(batch.created_at)})` : `Última calibragem ${ago(batch.ended_at || batch.created_at)}`) : "Nenhuma calibragem feita ainda"}
        action={ctx.isAdmin && <button className="btn" disabled={busy || running} onClick={run}>{busy ? "Enviando…" : running ? "Calibrando…" : "✨ Calibrar agora"}</button>}
      >
        {msg && <p className="callout">{msg}</p>}
        {items.length === 0 ? (
          <Empty>{cal.loading ? "Carregando…" : running ? "A primeira calibragem está em andamento. O resultado aparece aqui em alguns minutos." : "Nenhum atendente calibrado ainda."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl cal">
              <thead>
                <tr>
                  <th>Atendente</th>
                  <th>Nota geral</th>
                  {CRIT.map((c) => <th key={c.key} title={`${c.label}: ${c.hint}`}>{c.short}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr className="cal-avg">
                  <td><b>Média da equipe</b><div className="sub">{items.length} atendentes</div></td>
                  <td><Score s={avg(null)} big /></td>
                  {CRIT.map((c) => <td key={c.key}><Score s={avg(c.key)} /></td>)}
                  <td />
                </tr>
                {items.map((i) => {
                  const d = i.prev_overall != null && i.overall != null ? Number(i.overall) - Number(i.prev_overall) : null;
                  return (
                    <tr key={i.attendant_id} className="click" onClick={() => setOpen(i)}>
                      <td><b>{i.name}</b><div className="sub">{i.area || "—"} · {fmtNum(i.metrics?.msgs)} msgs</div></td>
                      <td>
                        <Score s={{ score: i.overall, evidence: true }} big />
                        {d != null && Math.abs(d) >= 0.1 && <span className={`delta ${d > 0 ? "good" : "bad"}`} title="Comparado à calibragem anterior"> {d > 0 ? "▲" : "▼"} {fmtScore(Math.abs(d))}</span>}
                      </td>
                      {CRIT.map((c) => <td key={c.key} title={i.scores?.[c.key]?.comment || ""}><Score s={i.scores?.[c.key]} /></td>)}
                      <td><button className="btn small ghost">Detalhes</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="cal-legend sub">
          <span><i className="cal-s good">8+</i> muito bom</span>
          <span><i className="cal-s warn">6–7,9</i> adequado</span>
          <span><i className="cal-s bad">&lt;6</i> precisa melhorar</span>
          <span><i className="cal-s na">—</i> sem evidência no período</span>
        </div>
      </Card>
      {open && <Detail item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Detail({ item, onClose }) {
  const m = item.metrics || {};
  const hist = item.history || [];
  return (
    <Modal title={`Calibragem · ${item.name}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row wrap cal-head">
          <Score s={{ score: item.overall, evidence: true }} big />
          <div>
            <p className="alert-txt">{item.summary}</p>
            <p className="sub">
              Período {new Date(item.period_from).toLocaleDateString("pt-BR")} a {new Date(item.period_to).toLocaleDateString("pt-BR")} ·{" "}
              {fmtNum(m.msgs)} mensagens em {fmtNum(m.groups)} grupos · {fmtNum(m.responses)} respostas · mediana {fmtDur(m.median_seconds)} ·{" "}
              {fmtPct(m.sla_pct)} no SLA · {fmtNum(m.initiatives)} iniciativas
            </p>
          </div>
        </div>
        <div className="grid g2">
          <div className="callout"><b>Pontos fortes</b><p className="alert-txt">{item.strengths}</p></div>
          <div className="callout warnbox"><b>Prioridades de desenvolvimento</b><p className="alert-txt">{item.improve}</p></div>
        </div>
        <div className="cal-grid">
          {CRIT.map((c) => {
            const s = item.scores?.[c.key] || {};
            const ok = s.evidence !== false && s.score != null;
            return (
              <section key={c.key} className="cal-card">
                <header className="row between">
                  <b>{c.label}</b>
                  <Score s={s} />
                </header>
                <div className="cal-bar"><i className={tone(ok ? s.score : null)} style={{ width: ok ? `${s.score * 10}%` : 0 }} /></div>
                <p className="alert-txt">{ok ? s.comment : s.comment || "Sem evidência suficiente no período."}</p>
                {s.examples?.length > 0 && <ul className="cal-ex">{s.examples.map((e, k) => <li key={k}>“{e}”</li>)}</ul>}
                {s.improve && <p className="sub">💡 {s.improve}</p>}
              </section>
            );
          })}
        </div>
        {hist.length > 1 && (
          <div>
            <b>Evolução da nota geral</b>
            <div className="cal-hist">
              {hist.map((h) => (
                <div key={h.at} title={`${new Date(h.at).toLocaleDateString("pt-BR")}: ${fmtScore(h.overall)}`}>
                  <span>{fmtScore(h.overall)}</span>
                  <i className={tone(Number(h.overall))} style={{ height: `${Number(h.overall) * 10}%` }} />
                  <small>{new Date(h.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</small>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
