import { useState } from "react";
import { rpc } from "../api.js";
import { ago, fmtDateTime, fmtDay, fmtDur, fmtNum } from "../lib/format.js";
import { Card, Delta, Empty, ErrorBox, HBars, InstanceTag, Kpi, Pill, Seg, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

const WHO = { cliente: "cliente", atendente: "time", supervisor: "supervisor" };

// Colunas por dia (preenche os dias sem mensagem).
function DayColumns({ rows, from, to }) {
  const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const days = [];
  const d = new Date(from);
  const end = new Date(to);
  while (d < end && days.length < 62) {
    const k = d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    if (!days.length || days[days.length - 1].day !== k) days.push({ day: k, n: map.get(k) || 0 });
    d.setDate(d.getDate() + 1);
  }
  const max = Math.max(1, ...days.map((x) => x.n));
  if (!days.some((x) => x.n)) return <Empty>Nenhuma mensagem do Helpdesk no período.</Empty>;
  return (
    <div className="hd-cols" role="img" aria-label="Mensagens do Helpdesk por dia">
      {days.map((x) => (
        <div key={x.day} className="hd-col" title={`${fmtDay(x.day)}: ${fmtNum(x.n)} mensagens`}>
          <span className="hd-v">{x.n ? fmtNum(x.n) : ""}</span>
          <span className="hd-b" style={{ height: `${(100 * x.n) / max}%` }} />
          <span className="hd-d">{fmtDay(x.day)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Helpdesk({ ctx }) {
  const { data, error, loading } = useData(
    () => rpc("dash_helpdesk", { p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to }),
    [ctx.inst, ctx.from, ctx.to]
  );
  const [open, setOpen] = useState(null);
  const [feed, setFeed] = useState("todas");
  const k = data?.kpis || {};
  const members = data?.members || [];
  const recent = (data?.recent || []).filter((r) => feed === "todas" || (feed === "entradas" && r.entry_seconds != null));

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="note">
        Acompanhamento do time interno de Helpdesk. As mensagens dele ficam <b>fora</b> das métricas de atendimento (não
        abrem espera e não contam no SLA). <b>Entrada</b> é quando alguém do Helpdesk escreve logo depois de um cliente ou
        do time (até 24h): mostra quanto tempo o Helpdesk leva para entrar na conversa e quem o acionou. Para incluir ou
        tirar alguém do Helpdesk, use Cadastros → Atendentes → Time.
      </p>
      <div className="kpis">
        <Kpi label="Mensagens do Helpdesk" value={fmtNum(k.msgs ?? 0)} delta={<Delta now={k.msgs} prev={k.prev_msgs} fmt={fmtNum} />} sub=" vs período anterior" />
        <Kpi label="Grupos atendidos" value={fmtNum(k.groups ?? 0)} />
        <Kpi label="Pessoas ativas" value={`${fmtNum(k.members_active ?? 0)} de ${fmtNum(k.members_total ?? 0)}`} />
        <Kpi label="Entradas na conversa" value={fmtNum(k.entries ?? 0)} sub={k.entries ? `${fmtNum(k.by_cliente)} após cliente · ${fmtNum(k.by_time)} após o time` : null} />
        <Kpi label="Tempo para entrar (mediana)" value={fmtDur(k.median_entry_seconds)} />
      </div>

      <Card title="Pessoas do Helpdesk">
        {members.length === 0 ? (
          <Empty>{loading ? "Carregando…" : "Ninguém cadastrado como Helpdesk ainda. Em Cadastros → Atendentes, escolha Time = Helpdesk."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Pessoa</th><th>Mensagens</th><th>Grupos</th><th>Entradas</th><th>Tempo p/ entrar (mediana)</th><th>Dias ativos</th><th>Última atividade</th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className={m.active ? "" : "muted"}>
                    <td><b>{m.name}</b><div className="sub">{m.area || "Helpdesk"}{!m.active && " · inativo"}</div></td>
                    <td>{fmtNum(m.msgs)}</td>
                    <td>{fmtNum(m.groups)}</td>
                    <td>{fmtNum(m.entries)}</td>
                    <td>{fmtDur(m.median_entry_seconds)}</td>
                    <td>{fmtNum(m.days_active)}</td>
                    <td>{ago(m.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Mensagens por dia" hint="Período selecionado no topo.">
          <DayColumns rows={data?.by_day || []} from={ctx.from} to={ctx.to} />
        </Card>
        <Card title="Grupos com mais Helpdesk" hint="Clique para ver a conversa.">
          {(data?.groups || []).length === 0 ? <Empty>Nada no período.</Empty> : (
            <div className="hd-groups">
              {data.groups.map((g) => (
                <button key={g.group_id} className="hd-g" onClick={() => setOpen({ group_id: g.group_id, group_name: g.group_name })}>
                  <span className="hd-gn">{g.group_name} <InstanceTag name={g.instance_name} color={g.instance_color} /></span>
                  <span className="sub">{fmtNum(g.msgs)} msgs · {g.members} pessoa(s) · {ago(g.last_at)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Últimas mensagens do Helpdesk"
        hint="Com a mensagem anterior do grupo, para ver o que motivou a entrada."
        action={<Seg value={feed} onChange={setFeed} options={[{ value: "todas", label: "Todas" }, { value: "entradas", label: "Só entradas" }]} />}
      >
        {recent.length === 0 ? <Empty>{loading ? "Carregando…" : "Nenhuma mensagem do Helpdesk no período."}</Empty> : (
          <div className="hd-feed">
            {recent.map((r) => (
              <article key={r.id} className="hd-item" onClick={() => setOpen(r)}>
                <header className="row between wrap">
                  <span><b>{r.name}</b> em <b>{r.group_name}</b> <InstanceTag name={r.instance_name} color={r.instance_color} /></span>
                  <span className="sub">{fmtDateTime(r.sent_at)}</span>
                </header>
                {r.prev_author && (
                  <p className="hd-prev">
                    ↳ antes, {r.prev_author === "helpdesk" ? "Helpdesk" : `${WHO[r.prev_author] || r.prev_author} (${r.prev_name})`}: {r.prev_text}
                  </p>
                )}
                <p className="hd-txt">{r.text}</p>
                {r.entry_seconds != null && <Pill cls="p-b">entrou {fmtDur(r.entry_seconds)} depois · acionado por {WHO[r.prev_author]}</Pill>}
              </article>
            ))}
          </div>
        )}
      </Card>
      {open && <Thread conversationId={open.conversation_id} groupId={open.group_id} title={open.group_name} onClose={() => setOpen(null)} />}
    </div>
  );
}
