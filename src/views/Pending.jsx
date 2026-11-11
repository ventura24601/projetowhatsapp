import { useState } from "react";
import { rpc } from "../api.js";
import { fmtDur, fmtDateTime } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, Pill, SlaPill } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

export default function Pending({ ctx, pending }) {
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [q, setQ] = useState("");
  const rows = pending.data || [];
  const late = rows.filter((r) => r.breached);
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const shown = terms.length
    ? rows.filter((r) => {
        const hay = norm([r.group_name, r.instance_name, r.first_message, r.last_message, r.owner_name, r.last_responder, r.customer_name].join(" "));
        return terms.every((t) => hay.includes(t));
      })
    : rows;

  async function resolve(r) {
    if (!confirm(`Marcar "${r.group_name}" como resolvido sem resposta? O tempo não entra nas métricas.`)) return;
    setBusy(r.group_id);
    try {
      await rpc("resolve_waiting", { p_group: r.group_id });
      await pending.reload();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <ErrorBox error={pending.error} />
      <p className="note">
        Grupos em que o cliente escreveu e ainda ninguém do time respondeu. Atualiza a cada minuto. Mensagens como “ok”,
        “obrigado” ou figurinhas não abrem espera.
      </p>
      <div className="kpis">
        <div className={`kpi ${rows.length ? "warn" : "good"}`}><span className="kpi-l">Aguardando</span><strong className="kpi-v">{rows.length}</strong></div>
        <div className={`kpi ${late.length ? "bad" : "good"}`}><span className="kpi-l">Fora do SLA</span><strong className="kpi-v">{late.length}</strong></div>
        <div className="kpi"><span className="kpi-l">Maior espera</span><strong className="kpi-v">{fmtDur(rows[0]?.eff_seconds)}</strong></div>
      </div>
      <Card
        title="Fila de espera"
        hint="Ordenado pela espera (em horário comercial, se configurado)"
        action={rows.length > 0 && (
          <input
            className="input search"
            type="search"
            placeholder="Pesquisar grupo, mensagem ou responsável…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Pesquisar na fila de espera"
          />
        )}
      >
        {terms.length > 0 && rows.length > 0 && (
          <p className="sub">{shown.length} de {rows.length} grupo(s){shown.length < rows.length && <> · <button className="btn small ghost" onClick={() => setQ("")}>Limpar</button></>}</p>
        )}
        {rows.length === 0 ? (
          <Empty>{pending.loading ? "Carregando…" : "Nenhum cliente aguardando resposta agora. 🎉"}</Empty>
        ) : shown.length === 0 ? (
          <Empty>Nenhum grupo na fila corresponde a “{q}”.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Grupo</th><th>Esperando</th><th>Desde</th><th>Mensagem do cliente</th><th>Responsável</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.group_id} className="click" onClick={() => setOpen(r)}>
                    <td>
                      <b>{r.group_name}</b>
                      <div className="sub"><InstanceTag name={r.instance_name} color={r.instance_color} /> · SLA {r.sla_minutes} min</div>
                    </td>
                    <td><SlaPill seconds={r.eff_seconds} slaMinutes={r.sla_minutes} />{r.wall_seconds - r.eff_seconds > 600 && <div className="sub">{fmtDur(r.wall_seconds)} corridos</div>}</td>
                    <td>{fmtDateTime(r.waiting_since)}</td>
                    <td className="msg">
                      “{r.first_message}”
                      {r.unanswered_msgs > 1 && <div className="sub">+{r.unanswered_msgs - 1} mensagem(ns) · última: “{r.last_message}”</div>}
                    </td>
                    <td>{r.owner_name || r.last_responder || <Pill>sem responsável</Pill>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {ctx.isAdmin && (
                        <button className="btn small ghost" disabled={busy === r.group_id} onClick={() => resolve(r)} title="Encerrar a espera sem contar nas métricas">
                          Dispensar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <Thread groupId={open.group_id} title={open.group_name} onClose={() => setOpen(null)} />}
    </div>
  );
}

function norm(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
