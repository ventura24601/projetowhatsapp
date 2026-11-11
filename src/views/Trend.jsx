import { useMemo, useState } from "react";
import { rpc } from "../api.js";
import { fmtDur, fmtNum, fmtPct } from "../lib/format.js";
import { Card, Empty, ErrorBox, Seg, useData } from "../components/ui.jsx";

const DOW = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const TZ = "America/Sao_Paulo";
const dm = (ymd) => { const [, m, d] = ymd.split("-"); return `${d}/${m}`; };
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

const EMPTY = { customer_msgs: 0, team_msgs: 0, responses: 0, median_seconds: null, p90_seconds: null, sla_pct: null, breached: 0, active_groups: 0 };

// Preenche os buckets sem movimento para o eixo não pular dias/semanas.
function buckets(data, mode) {
  if (!data) return [];
  const src = mode === "week" ? data.by_week : mode === "day" ? data.by_day : data.by_dow;
  const map = new Map(src.map((r) => [String(r.k), r]));
  const start = new Date(data.from).toLocaleDateString("en-CA", { timeZone: TZ });
  const keys = [];
  if (mode === "dow") for (let i = 1; i <= 7; i++) keys.push(String(i));
  else for (let k = start; k <= today(); k = addDays(k, mode === "week" ? 7 : 1)) keys.push(k);
  return keys.map((k) => {
    const label = mode === "dow" ? DOW[Number(k) - 1] : dm(k);
    const long = mode === "dow" ? `${DOW[Number(k) - 1]} (soma do período)` : mode === "week" ? `Semana de ${dm(k)} a ${dm(addDays(k, 6))}` : new Date(`${k}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
    return { k, label, long, ...EMPTY, ...map.get(k) };
  });
}

export default function TrendCard({ ctx }) {
  const [mode, setMode] = useState("week");
  const [weeks, setWeeks] = useState(8);
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const { data, error, loading } = useData(() => rpc("dash_trend", { p_instance: ctx.inst, p_weeks: weeks }), [ctx.inst, weeks], { refreshMs: 300000 });
  const rows = useMemo(() => buckets(data, mode), [data, mode]);
  const cur = hover != null ? rows[hover] : rows[rows.length - 1];
  const every = rows.length > 40 ? 7 : rows.length > 20 ? 3 : 1;

  const charts = [
    {
      title: "Mensagens",
      series: [
        { key: "customer_msgs", name: "Clientes", color: "var(--acc)" },
        { key: "team_msgs", name: "Time", color: "var(--orange)" },
      ],
      fmt: fmtNum,
    },
    { title: "Tempo de resposta (mediana)", series: [{ key: "median_seconds", name: "Mediana", color: "var(--acc)" }], fmt: fmtDur },
    { title: "Dentro do SLA", series: [{ key: "sla_pct", name: "% no SLA", color: "var(--acc)" }], fmt: fmtPct, max: 100, ref: 90 },
  ];

  return (
    <Card
      title="Tendência semana a semana"
      hint={`Últimas ${weeks} semanas (independe do período do topo). Passe o mouse para ver os números.`}
      action={
        <div className="row wrap">
          <Seg value={mode} onChange={setMode} options={[{ value: "week", label: "Por semana" }, { value: "day", label: "Por dia" }, { value: "dow", label: "Dia da semana" }]} />
          <Seg value={weeks} onChange={setWeeks} options={[{ value: 4, label: "4 sem" }, { value: 8, label: "8 sem" }, { value: 12, label: "12 sem" }]} />
        </div>
      }
    >
      <ErrorBox error={error} />
      {!data ? (
        <Empty>{loading ? "Carregando…" : "Sem dados."}</Empty>
      ) : (
        <>
          {cur && (
            <div className="trend-detail">
              <b>{cur.long}</b>
              <span><i className="sw" style={{ background: "var(--acc)" }} />Clientes {fmtNum(cur.customer_msgs)}</span>
              <span><i className="sw" style={{ background: "var(--orange)" }} />Time {fmtNum(cur.team_msgs)}</span>
              <span>Respostas {fmtNum(cur.responses)}</span>
              <span>Mediana {fmtDur(cur.median_seconds)}</span>
              <span>90% em até {fmtDur(cur.p90_seconds)}</span>
              <span>No SLA {fmtPct(cur.sla_pct)}</span>
              <span>Fora do SLA {fmtNum(cur.breached)}</span>
              <span>Grupos ativos {fmtNum(cur.active_groups)}</span>
            </div>
          )}
          <div className="trend-grid">
            {charts.map((c) => (
              <Bars key={c.title} chart={c} rows={rows} every={every} hover={hover} setHover={setHover} />
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small ghost" onClick={() => setTable(!table)}>{table ? "Esconder tabela" : "Ver em tabela"}</button>
          </div>
          {table && (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>{mode === "week" ? "Semana" : mode === "day" ? "Dia" : "Dia da semana"}</th><th>Msgs clientes</th><th>Msgs time</th><th>Respostas</th><th>Mediana</th><th>90% em até</th><th>No SLA</th><th>Fora do SLA</th><th>Grupos ativos</th></tr></thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={r.k}>
                      <td>{r.long}</td><td>{fmtNum(r.customer_msgs)}</td><td>{fmtNum(r.team_msgs)}</td><td>{fmtNum(r.responses)}</td>
                      <td>{fmtDur(r.median_seconds)}</td><td>{fmtDur(r.p90_seconds)}</td><td>{fmtPct(r.sla_pct)}</td><td>{fmtNum(r.breached)}</td><td>{fmtNum(r.active_groups)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Bars({ chart, rows, every, hover, setHover }) {
  const vals = rows.flatMap((r) => chart.series.map((s) => Number(r[s.key]) || 0));
  const max = chart.max ?? Math.max(...vals, 1);
  const peak = Math.max(...vals);
  const showAll = rows.length <= 14;
  return (
    <figure className="trend">
      <figcaption>
        {chart.title}
        {chart.series.length > 1 && (
          <span className="legend">
            {chart.series.map((s) => <span key={s.key}><i className="sw" style={{ background: s.color }} />{s.name}</span>)}
          </span>
        )}
      </figcaption>
      <div className="tr-plot" onMouseLeave={() => setHover(null)}>
        {chart.ref != null && <div className="tr-ref" style={{ bottom: `${(100 * chart.ref) / max}%` }}><span>meta {chart.ref}%</span></div>}
        {rows.map((r, i) => (
          <div key={r.k} className={`tr-col ${hover === i ? "on" : ""}`} onMouseEnter={() => setHover(i)} title={`${r.long}: ${chart.series.map((s) => `${s.name} ${chart.fmt(r[s.key])}`).join(" · ")}`}>
            <div className="tr-bars">
              {chart.series.map((s) => {
                const v = r[s.key];
                const h = v == null ? 0 : (100 * Number(v)) / max;
                const label = v != null && Number(v) > 0 && (showAll || hover === i || (Number(v) === peak && peak > 0));
                return (
                  <div key={s.key} className="tr-bar-wrap">
                    {label && <span className="tr-v" style={{ bottom: `calc(${h}% + 2px)` }}>{chart.fmt(v)}</span>}
                    <div className="tr-bar" style={{ height: `${h}%`, background: s.color, minHeight: v ? 2 : 0 }} />
                  </div>
                );
              })}
            </div>
            <span className="tr-l">{i % every === 0 || i === rows.length - 1 ? r.label : ""}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
