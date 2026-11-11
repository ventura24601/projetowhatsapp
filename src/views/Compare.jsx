import { rpc } from "../api.js";
import { fmtDur, fmtNum, fmtPct } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, useData } from "../components/ui.jsx";

const n = (v) => (v == null ? null : Number(v));
const pctOf = (a, b) => (n(b) ? (100 * n(a)) / n(b) : null);

// better: "down" = menor é melhor, "up" = maior é melhor, null = só informativo
const ROWS = [
  { section: "Tempo de resposta" },
  { label: "Mediana", get: (i) => n(i.kpis.median_seconds), fmt: fmtDur, better: "down", prev: (i) => n(i.prev?.median_seconds) },
  { label: "90% respondidos em até", get: (i) => n(i.kpis.p90_seconds), fmt: fmtDur, better: "down" },
  { label: "1ª resposta do atendimento (mediana)", get: (i) => n(i.kpis.first_median), fmt: fmtDur, better: "down" },
  { label: "Dentro do SLA", get: (i) => n(i.kpis.sla_pct), fmt: fmtPct, better: "up", prev: (i) => n(i.prev?.sla_pct) },
  { label: "Respostas fora do SLA", get: (i) => n(i.kpis.breached), fmt: fmtNum, better: "down" },
  { section: "Volume" },
  { label: "Mensagens de clientes", get: (i) => n(i.customer_msgs), fmt: fmtNum },
  { label: "Mensagens do time", get: (i) => n(i.team_msgs), fmt: fmtNum },
  { label: "Respostas do time", get: (i) => n(i.kpis.responses), fmt: fmtNum },
  { label: "Atendimentos iniciados", get: (i) => n(i.conversations), fmt: fmtNum },
  { label: "Grupos ativos", get: (i) => n(i.active_groups), fmt: fmtNum, sub: (i) => `de ${fmtNum(i.monitored_groups)} monitorados` },
  { section: "Agora" },
  { label: "Aguardando resposta", get: (i) => n(i.waiting_now), fmt: fmtNum, better: "down", sub: (i) => (n(i.waiting_breached) ? `${fmtNum(i.waiting_breached)} fora do SLA` : null) },
  { label: "Casos abertos com o time (7 dias)", get: (i) => n(i.open_cases), fmt: fmtNum, better: "down" },
  { section: "Qualidade (IA)" },
  { label: "Casos encerrados no período", get: (i) => n(i.closed_cases), fmt: fmtNum },
  { label: "Clientes insatisfeitos", get: (i) => pctOf(i.negative, i.analyzed), fmt: fmtPct, better: "down", sub: (i) => `${fmtNum(i.negative)} de ${fmtNum(i.analyzed)} analisados` },
  { label: "Nota média do atendimento", get: (i) => n(i.quality), fmt: (v) => (v == null ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })), better: "up" },
  { label: "Quem mais respondeu", text: (i) => i.top_attendant?.name || "—", sub: (i) => (i.top_attendant ? `${fmtNum(i.top_attendant.responses)} respostas` : null) },
];

export default function CompareCard({ ctx }) {
  const { data, error, loading } = useData(() => rpc("dash_compare", { p_from: ctx.from, p_to: ctx.to }), [ctx.from, ctx.to]);
  const inst = data || [];
  return (
    <Card title="Comparativo entre os números" hint="Mesmo período selecionado acima, independente do filtro de número. Destaque = melhor resultado.">
      <ErrorBox error={error} />
      {inst.length < 2 ? (
        <Empty>{loading ? "Carregando…" : "É preciso ter dois números cadastrados para comparar."}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="tbl compare">
            <thead>
              <tr>
                <th />
                {inst.map((i) => <th key={i.slug}><InstanceTag name={i.name} color={i.color} /></th>)}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (r.section ? (
                <tr key={r.section} className="cmp-sec"><td colSpan={inst.length + 1}>{r.section}</td></tr>
              ) : (
                <Row key={r.label} row={r} inst={inst} />
              )))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Row({ row, inst }) {
  const vals = row.get ? inst.map(row.get) : [];
  const valid = vals.filter((v) => v != null);
  let best = null;
  if (row.better && valid.length === inst.length && new Set(valid).size > 1) {
    best = row.better === "down" ? Math.min(...valid) : Math.max(...valid);
  }
  return (
    <tr>
      <th scope="row">{row.label}</th>
      {inst.map((i, k) => {
        const v = vals[k];
        const prev = row.prev?.(i);
        const sub = row.sub?.(i);
        return (
          <td key={i.slug} className={best != null && v === best ? "cmp-best" : ""}>
            <b>{row.text ? row.text(i) : row.fmt(v)}</b>
            {prev != null && v != null && prev !== v && (
              <span className={`delta ${(row.better === "down" ? v < prev : v > prev) ? "good" : "bad"}`} title="Comparado ao período anterior de mesmo tamanho">
                {" "}{v > prev ? "▲" : "▼"}
              </span>
            )}
            {sub && <div className="sub">{sub}</div>}
          </td>
        );
      })}
    </tr>
  );
}
