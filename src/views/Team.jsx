import { rpc } from "../api.js";
import { fmtDur, fmtNum, fmtPct, ago } from "../lib/format.js";
import { Card, Empty, ErrorBox, Pill, useData } from "../components/ui.jsx";

export default function Team({ ctx }) {
  const { data, error, loading } = useData(
    () => rpc("dash_team", { p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to }),
    [ctx.inst, ctx.from, ctx.to]
  );
  const rows = data || [];
  const withResp = rows.filter((r) => Number(r.responses) > 0);
  const best = [...withResp].filter((r) => r.responses >= 3).sort((a, b) => a.median_seconds - b.median_seconds)[0];

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="note">
        Cada resposta é creditada a quem respondeu primeiro depois do cliente. “Supervisor” é o próprio número monitorado
        (mensagens enviadas por ele). A nota de qualidade vem da análise por IA dos atendimentos.
      </p>
      {best && (
        <div className="callout">🏆 Resposta mais rápida no período: <b>{best.name}</b> — mediana de {fmtDur(best.median_seconds)} em {best.responses} respostas.</div>
      )}
      <Card title="Desempenho por pessoa">
        {rows.length === 0 ? (
          <Empty>{loading ? "Carregando…" : "Nenhum atendente cadastrado. Cadastre os números do time em Cadastros."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Pessoa</th><th>Respostas</th><th>Mediana</th><th>Média</th><th>No SLA</th>
                  <th>1ªs respostas</th><th>Mensagens</th><th>Grupos</th><th>Qualidade (IA)</th><th>Última atividade</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id || r.name}>
                    <td>
                      <b>{r.name}</b>
                      <div className="sub">{r.area || "—"}{!r.active && " · inativo"}</div>
                    </td>
                    <td>{fmtNum(r.responses || 0)}</td>
                    <td>{fmtDur(r.median_seconds)}</td>
                    <td>{fmtDur(r.avg_seconds)}</td>
                    <td>{r.sla_pct == null ? "—" : <Pill cls={r.sla_pct >= 90 ? "p-g" : r.sla_pct >= 75 ? "p-a" : "p-r"}>{fmtPct(r.sla_pct)}</Pill>}</td>
                    <td>{fmtNum(r.first_responses || 0)}</td>
                    <td>{fmtNum(r.msgs)}</td>
                    <td>{fmtNum(r.groups)}</td>
                    <td>{r.quality == null ? "—" : <span title={`${r.evaluated} atendimentos avaliados`}>{r.quality}/10</span>}</td>
                    <td>{ago(r.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
