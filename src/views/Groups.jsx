import { useState } from "react";
import { rpc } from "../api.js";
import { fmtDur, fmtNum, fmtPct, ago, SENTIMENT } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, Modal, Pill, SlaPill, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

export default function Groups({ ctx }) {
  const { data, error, loading, reload } = useData(
    () => rpc("dash_groups", { p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to }),
    [ctx.inst, ctx.from, ctx.to]
  );
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);

  const rows = (data || []).filter(
    (g) => (showHidden || g.monitored) && (!q || g.name.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="note">
        Os grupos aparecem sozinhos quando chega a primeira mensagem. Defina SLA específico, responsável e quais grupos
        não devem entrar nas métricas (ex.: grupos internos).
      </p>
      <Card
        title={`${rows.length} grupos`}
        action={
          <div className="row">
            <input className="input" placeholder="Buscar grupo…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> mostrar ignorados</label>
          </div>
        }
      >
        {rows.length === 0 ? (
          <Empty>{loading ? "Carregando…" : "Nenhum grupo ainda. Assim que a Z-API enviar mensagens, eles aparecem aqui."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Grupo</th><th>Situação</th><th>Msgs cliente / time</th><th>Respostas</th><th>Mediana</th><th>No SLA</th><th>Clima</th><th>Responsável</th><th>Última msg</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id} className={`click ${g.monitored ? "" : "muted"}`} onClick={() => setOpen(g)}>
                    <td><b>{g.name}</b><div className="sub"><InstanceTag name={g.instance_name} color={g.instance_color} /> · SLA {g.effective_sla} min{g.sla_minutes ? " (próprio)" : ""}</div></td>
                    <td>{!g.monitored ? <Pill>ignorado</Pill> : g.waiting_since ? <SlaPill seconds={g.waiting_eff} slaMinutes={g.effective_sla} /> : <Pill cls="p-g">em dia</Pill>}</td>
                    <td>{fmtNum(g.customer_msgs)} / {fmtNum(g.team_msgs)}</td>
                    <td>{fmtNum(g.responses)}</td>
                    <td>{fmtDur(g.median_seconds)}</td>
                    <td>{g.sla_pct == null ? "—" : fmtPct(g.sla_pct)}</td>
                    <td>{g.last_sentiment ? <Pill cls={SENTIMENT[g.last_sentiment]?.cls}>{SENTIMENT[g.last_sentiment]?.label}</Pill> : "—"}</td>
                    <td>{g.owner_name || "—"}</td>
                    <td>{ago(g.last_message_at)}</td>
                    <td onClick={(e) => e.stopPropagation()}>{ctx.isAdmin && <button className="btn small ghost" onClick={() => setEdit(g)}>Editar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <Thread groupId={open.id} title={open.name} onClose={() => setOpen(null)} />}
      {edit && <EditGroup group={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function EditGroup({ group, onClose, onSaved }) {
  const attendants = useData(() => rpc("list_attendants"), []);
  const [f, setF] = useState({
    sla_minutes: group.sla_minutes ?? "",
    owner_attendant_id: group.owner_attendant_id ?? "",
    monitored: group.monitored,
    notes: group.notes ?? "",
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await rpc("save_group", { p: { id: group.id, ...f, sla_minutes: f.sla_minutes === "" ? "" : String(f.sla_minutes) } });
      onSaved();
    } catch (e2) {
      setErr(e2.message);
      setSaving(false);
    }
  }

  return (
    <Modal title={`Editar · ${group.name}`} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox error={err} />
        <label>SLA deste grupo (minutos)
          <input className="input" type="number" min="1" placeholder={`padrão: ${group.effective_sla}`} value={f.sla_minutes} onChange={(e) => setF({ ...f, sla_minutes: e.target.value })} />
        </label>
        <label>Responsável
          <select className="input" value={f.owner_attendant_id} onChange={(e) => setF({ ...f, owner_attendant_id: e.target.value })}>
            <option value="">— nenhum —</option>
            {(attendants.data || []).filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={f.monitored} onChange={(e) => setF({ ...f, monitored: e.target.checked })} /> Considerar nas métricas</label>
        <label>Observações
          <textarea className="input" rows="3" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </Modal>
  );
}
