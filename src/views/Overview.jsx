import { rpc } from "../api.js";
import { fmtDur, fmtNum, fmtPct, fmtDay, ago } from "../lib/format.js";
import { Card, Kpi, Delta, useData, HBars, ErrorBox, Empty, InstanceTag } from "../components/ui.jsx";

const DOW = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export default function Overview({ ctx }) {
  const { data, error, loading } = useData(
    () => rpc("dash_overview", { p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to }),
    [ctx.inst, ctx.from, ctx.to]
  );
  if (!data) return <>{loading ? <Empty>Carregando…</Empty> : null}<ErrorBox error={error} /></>;
  const k = data.kpis;
  const p = data.prev || {};
  const bh = data.business_hours;
  const slaTone = k.sla_pct == null ? "" : k.sla_pct >= 90 ? "good" : k.sla_pct >= 75 ? "warn" : "bad";

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="note">
        {bh.enabled
          ? `Tempos contados só em horário comercial (${bh.start.slice(0, 5)}–${bh.end.slice(0, 5)}, ${bh.days.map((d) => DOW[d - 1]).join(", ")}).`
          : "Tempos contados em relógio corrido (24h)."}{" "}
        Uma “resposta” é a primeira mensagem do time depois de uma ou mais mensagens do cliente.
      </p>

      <div className="kpis">
        <Kpi
          label="Tempo de resposta (mediana)"
          value={fmtDur(k.median_seconds)}
          delta={<Delta now={k.median_seconds} prev={p.median_seconds} better="down" fmt={fmtDur} />}
          sub={`· 90% em até ${fmtDur(k.p90_seconds)}`}
        />
        <Kpi
          label="Dentro do SLA"
          value={fmtPct(k.sla_pct)}
          tone={slaTone}
          delta={<Delta now={k.sla_pct} prev={p.sla_pct} fmt={(v) => `${v.toFixed(1)} p.p.`} />}
          sub={`· ${fmtNum(k.breached)} fora do prazo`}
        />
        <Kpi label="Respostas do time" value={fmtNum(k.responses)} sub={`${fmtNum(k.conversations)} atendimentos · ${fmtNum(k.active_groups)} grupos`} />
        <Kpi label="1ª resposta (mediana)" value={fmtDur(k.first_median)} sub="primeira resposta de cada atendimento" />
        <Kpi
          label="Aguardando agora"
          value={fmtNum(k.waiting_now)}
          tone={k.waiting_breached > 0 ? "bad" : k.waiting_now > 0 ? "warn" : "good"}
          sub={`${fmtNum(k.waiting_breached)} já fora do SLA`}
        />
        <Kpi label="Mensagens" value={fmtNum(Number(k.customer_msgs) + Number(k.team_msgs))} sub={`${fmtNum(k.customer_msgs)} clientes · ${fmtNum(k.team_msgs)} time`} />
      </div>

      {data.by_instance.length > 1 && (
        <div className="grid g2">
          {data.by_instance.map((i) => (
            <Card key={i.slug} title={<InstanceTag name={i.name} color={i.color} />} hint={`Último evento recebido: ${ago(i.last_event_at)}`}>
              <div className="stat3">
                <div><b>{fmtDur(i.kpis.median_seconds)}</b><span>mediana</span></div>
                <div><b>{fmtPct(i.kpis.sla_pct)}</b><span>no SLA</span></div>
                <div><b>{fmtNum(i.kpis.responses)}</b><span>respostas</span></div>
                <div><b>{fmtNum(i.waiting_now)}</b><span>aguardando</span></div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="grid g2">
        <Card title="Evolução diária" hint="Barra = mediana do tempo de resposta; número = % dentro do SLA">
          <DayChart rows={data.by_day} />
        </Card>
        <Card title="Distribuição do tempo de resposta">
          <HBars rows={data.buckets} format={fmtNum} color={(r) => (["até 5 min", "5–15 min", "15–30 min"].includes(r.label) ? "var(--grn)" : r.label === "30–60 min" ? "var(--amb)" : "var(--red)")} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Grupos com mais respostas fora do SLA">
          {data.worst_groups.length === 0 ? (
            <Empty>Nenhuma resposta fora do SLA no período. 🎉</Empty>
          ) : (
            <table className="tbl">
              <thead><tr><th>Grupo</th><th>Fora do SLA</th><th>Mediana</th></tr></thead>
              <tbody>
                {data.worst_groups.map((g) => (
                  <tr key={g.group_id}>
                    <td>{g.group_name}<div className="sub">{g.instance_name}</div></td>
                    <td>{g.breached} de {g.responses}</td>
                    <td>{fmtDur(g.median_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Quando os clientes mais escrevem" hint="Mensagens de clientes por dia da semana e hora">
          <Heat cells={data.heat} />
        </Card>
      </div>
    </div>
  );
}

function DayChart({ rows }) {
  if (!rows.length) return <Empty>Sem respostas no período.</Empty>;
  const max = Math.max(...rows.map((r) => Number(r.median_seconds) || 0), 60);
  return (
    <div className="daychart" role="img" aria-label="Mediana diária do tempo de resposta">
      {rows.map((r) => {
        const sla = Number(r.sla_pct);
        const cls = sla >= 90 ? "good" : sla >= 75 ? "warn" : "bad";
        return (
          <div className="dc-col" key={r.day} title={`${fmtDay(r.day)}: mediana ${fmtDur(r.median_seconds)}, ${r.responses} respostas, ${fmtPct(sla)} no SLA`}>
            <span className={`dc-pct ${cls}`}>{Math.round(sla)}%</span>
            <span className="dc-bar-wrap"><span className={`dc-bar ${cls}`} style={{ height: `${(100 * r.median_seconds) / max}%` }} /></span>
            <span className="dc-l">{fmtDay(r.day)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Heat({ cells }) {
  if (!cells.length) return <Empty>Sem mensagens no período.</Empty>;
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, Number(c.n)]));
  const max = Math.max(...map.values());
  const hours = Array.from({ length: 17 }, (_, i) => i + 6);
  return (
    <div className="heat">
      <div className="heat-row head"><span />{hours.map((h) => <span key={h}>{h % 3 === 0 ? h : ""}</span>)}</div>
      {DOW.map((d, i) => (
        <div className="heat-row" key={d}>
          <span>{d}</span>
          {hours.map((h) => {
            const n = map.get(`${i + 1}-${h}`) || 0;
            return <span key={h} className="hc" title={`${d} ${h}h: ${n} mensagens`} style={{ opacity: n ? 0.15 + (0.85 * n) / max : 0.06 }} />;
          })}
        </div>
      ))}
    </div>
  );
}
