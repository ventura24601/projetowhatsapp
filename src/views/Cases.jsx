import { useState } from "react";
import { rpc, reviewCasesNow } from "../api.js";
import { fmtNum, fmtDateTime, ago } from "../lib/format.js";
import { Card, Kpi, Pill, Empty, ErrorBox, InstanceTag, useData } from "../components/ui.jsx";

const CLOSED_BY = {
  cliente: { label: "pelo cliente", cls: "p-g" },
  equipe: { label: "pela equipe", cls: "p-b" },
  sem_demanda: { label: "sem demanda", cls: "p-n" },
  manual: { label: "manual", cls: "p-a" },
};

// Casos abertos x encerrados (revisão por IA às 9h, 13h e 17h) — card da home.
export default function CasesCard({ ctx }) {
  const { data, error, reload } = useData(() => rpc("dash_cases", { p_instance: ctx.inst }), [ctx.inst], { refreshMs: 60000 });
  const [run, setRun] = useState({ busy: false, msg: null });
  const [busyId, setBusyId] = useState(null);

  async function review() {
    setRun({ busy: true, msg: null });
    try {
      const r = await reviewCasesNow();
      setRun({
        busy: false,
        msg: r.skipped
          ? "Já há uma revisão em andamento. O resultado aparece aqui em alguns minutos."
          : r.submitted
            ? `${r.submitted} caso(s) enviados para a IA. O resultado aparece aqui em alguns minutos.`
            : "Nenhum caso com novidade para revisar.",
      });
      reload();
    } catch (e) {
      setRun({ busy: false, msg: `Erro: ${e.message}` });
    }
  }

  async function setCase(id, status) {
    setBusyId(id);
    try {
      await rpc("case_set", { p_conversation: id, p_status: status });
      reload();
      ctx.reloadPending?.();
    } finally {
      setBusyId(null);
    }
  }

  if (!data) return <ErrorBox error={error} />;
  const lr = data.last_review;
  const c7 = data.closed_7d || {};

  return (
    <Card
      title="Casos abertos e encerrados"
      hint={
        lr
          ? `IA revisa às 9h, 13h e 17h · última revisão ${fmtDateTime(lr.created_at)}${lr.status === "open" ? " (em andamento)" : lr.result ? ` · ${fmtNum(lr.result.closed ?? 0)} encerrado(s) de ${fmtNum(lr.result.saved ?? 0)}` : ""}`
          : "IA revisa às 9h, 13h e 17h"
      }
      action={ctx.isAdmin && (
        <button className="btn" onClick={review} disabled={run.busy || lr?.status === "open"}>
          {run.busy ? "Enviando…" : lr?.status === "open" ? "Revisão em andamento…" : "✨ Revisar casos com IA"}
        </button>
      )}
    >
      <ErrorBox error={error} />
      {run.msg && <div className="callout">{run.msg}</div>}
      <div className="kpis">
        <Kpi label="Abertos — time precisa agir" value={fmtNum(data.open_team)} tone={data.open_team > 0 ? "warn" : "good"} />
        <Kpi label="Abertos — aguardando cliente" value={fmtNum(data.open_client)} />
        <Kpi label="Encerrados hoje" value={fmtNum(data.closed_today)} tone="good" />
        <Kpi
          label="Encerrados em 7 dias"
          value={fmtNum(Object.values(c7).reduce((a, b) => a + Number(b), 0))}
          sub={Object.entries(CLOSED_BY).filter(([k]) => c7[k]).map(([k, v]) => `${c7[k]} ${v.label}`).join(" · ")}
        />
        <Kpi label="Com novidade a revisar" value={fmtNum(data.unchecked)} sub="mensagens depois da última revisão" />
      </div>

      <div className="grid g2">
        <div>
          <h3>Abertos</h3>
          {data.open_list.length === 0 ? <Empty>Nenhum caso aberto. 🎉</Empty> : (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {data.open_list.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.group_name}</b>
                        <div className="sub"><InstanceTag name={r.instance_name} color={r.instance_color} /> · {ago(r.last_message_at)}</div>
                        <div className="sub">{r.reason || (r.unchecked ? "Ainda não revisado pela IA" : "")}</div>
                      </td>
                      <td>
                        {r.next_step === "cliente" ? <Pill cls="p-n">aguarda cliente</Pill> : <Pill cls={r.waiting ? "p-r" : "p-a"}>time</Pill>}
                        {r.unchecked && <div className="sub">novidade</div>}
                      </td>
                      {ctx.isAdmin && (
                        <td>
                          <button className="btn small ghost" disabled={busyId === r.id} onClick={() => setCase(r.id, "encerrado")}>Encerrar</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3>Encerrados recentemente</h3>
          {data.closed_list.length === 0 ? <Empty>Nenhum caso encerrado ainda.</Empty> : (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {data.closed_list.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.group_name}</b>
                        <div className="sub"><InstanceTag name={r.instance_name} color={r.instance_color} /> · {ago(r.closed_at)}</div>
                        {r.reason && <div className="sub">{r.reason}</div>}
                      </td>
                      <td><Pill cls={CLOSED_BY[r.closed_by]?.cls}>{CLOSED_BY[r.closed_by]?.label ?? r.closed_by}</Pill></td>
                      {ctx.isAdmin && (
                        <td>
                          <button className="btn small ghost" disabled={busyId === r.id} onClick={() => setCase(r.id, "aberto")}>Reabrir</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
