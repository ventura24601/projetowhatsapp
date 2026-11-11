import { useState } from "react";
import { rpc } from "../api.js";
import { ago, fmtDur, fmtNum } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, Pill, Seg, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

const LEVEL = {
  critico: { label: "Crítico", cls: "p-r" },
  atencao: { label: "Atenção", cls: "p-a" },
  observar: { label: "Observar", cls: "p-b" },
};

export default function Alerts({ ctx }) {
  const alerts = useData(() => rpc("dash_alerts", { p_instance: ctx.inst }), [ctx.inst], { refreshMs: 60000 });
  const [filter, setFilter] = useState("abertos");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const items = alerts.data?.items || [];
  const c = alerts.data?.counts || {};
  const shown = items.filter((i) =>
    filter === "acompanhando" ? i.acked : !i.acked && (filter === "abertos" || i.level === filter)
  );

  async function act(i, fn) {
    setBusy(i.conversation_id);
    setErr(null);
    try {
      await fn();
      await alerts.reload();
      ctx.reloadAlerts?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }
  const ack = (i) => {
    const note = prompt("Acompanhando este caso. Quer deixar uma observação? (opcional)", "");
    if (note === null) return;
    act(i, () => rpc("alert_ack", { p_conversation: i.conversation_id, p_note: note }));
  };
  const unack = (i) => act(i, () => rpc("alert_unack", { p_conversation: i.conversation_id }));
  const close = (i) =>
    confirm(`Encerrar o caso de "${i.group_name}"? Ele sai dos alertas e dos casos abertos.`) &&
    act(i, () => rpc("case_set", { p_conversation: i.conversation_id, p_status: "encerrado" }));

  return (
    <div className="stack">
      <ErrorBox error={alerts.error || err} />
      <p className="note">
        Casos abertos dos últimos 7 dias que pedem o olhar da supervisão: cliente irritado ou insatisfeito, fala em
        cancelar, espera muito acima do SLA, cliente insistindo, “vou verificar” sem retorno, promessa não cumprida,
        caso parado há mais de 24h ou nota baixa. Clique em <b>Acompanhando</b> para tirar da lista; o alerta volta
        se o cliente escrever de novo. Atualiza a cada minuto.
      </p>
      <div className="kpis">
        <div className={`kpi ${c.critico ? "bad" : "good"}`}><span className="kpi-l">Crítico</span><strong className="kpi-v">{fmtNum(c.critico ?? 0)}</strong></div>
        <div className={`kpi ${c.atencao ? "warn" : "good"}`}><span className="kpi-l">Atenção</span><strong className="kpi-v">{fmtNum(c.atencao ?? 0)}</strong></div>
        <div className="kpi"><span className="kpi-l">Observar</span><strong className="kpi-v">{fmtNum(c.observar ?? 0)}</strong></div>
        <div className="kpi"><span className="kpi-l">Já acompanhando</span><strong className="kpi-v">{fmtNum(c.acked ?? 0)}</strong></div>
      </div>
      <Card
        title="Alertas"
        hint="Mais graves primeiro. A gravidade soma os motivos encontrados."
        action={
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { value: "abertos", label: "Todos" },
              { value: "critico", label: "Crítico" },
              { value: "atencao", label: "Atenção" },
              { value: "observar", label: "Observar" },
              { value: "acompanhando", label: "Acompanhando" },
            ]}
          />
        }
      >
        {shown.length === 0 ? (
          <Empty>{alerts.loading ? "Carregando…" : filter === "acompanhando" ? "Nenhum caso marcado como acompanhando." : "Nenhum alerta aqui agora. ✅"}</Empty>
        ) : (
          <div className="alerts">
            {shown.map((i) => (
              <article key={i.conversation_id} className={`alert lv-${i.level}`}>
                <header className="row between wrap">
                  <div className="row wrap">
                    <Pill cls={LEVEL[i.level].cls}>{LEVEL[i.level].label}</Pill>
                    <b className="alert-g">{i.group_name}</b>
                    <InstanceTag name={i.instance_name} color={i.instance_color} />
                  </div>
                  <span className="sub">
                    última mensagem {ago(i.last_message_at)}
                    {i.waiting && ` · esperando há ${fmtDur(i.eff_seconds)} (SLA ${i.sla_minutes} min)`}
                    {i.owner_name && ` · resp.: ${i.owner_name}`}
                  </span>
                </header>
                <div className="chips">
                  {i.reasons.map((r) => <span key={r.code} className={`chip w${Math.min(r.weight, 5)}`}>{r.label}</span>)}
                </div>
                {(i.summary || i.case_reason) && (
                  <p className="alert-txt">{i.summary || i.case_reason}{i.summary && i.case_reason && i.case_reason !== i.summary && <span className="sub"> · {i.case_reason}</span>}</p>
                )}
                {i.acked && (
                  <p className="sub">
                    ✔ Acompanhando desde {ago(i.ack_at)}{i.ack_by && ` por ${i.ack_by}`}{i.ack_note && ` — “${i.ack_note}”`}
                  </p>
                )}
                <div className="row wrap">
                  <button className="btn small" onClick={() => setOpen(i)}>Ver conversa</button>
                  {i.acked ? (
                    <button className="btn small ghost" disabled={busy === i.conversation_id} onClick={() => unack(i)}>Voltar para alertas</button>
                  ) : (
                    <button className="btn small ghost" disabled={busy === i.conversation_id} onClick={() => ack(i)}>Acompanhando</button>
                  )}
                  {ctx.isAdmin && (
                    <button className="btn small ghost" disabled={busy === i.conversation_id} onClick={() => close(i)}>Encerrar caso</button>
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
