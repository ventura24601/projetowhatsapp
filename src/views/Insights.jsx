import { useState } from "react";
import { rpc, analyzeNow } from "../api.js";
import { fmtNum, fmtPct, fmtDateTime, SENTIMENT } from "../lib/format.js";
import { Card, Kpi, Empty, ErrorBox, HBars, Pill, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

export default function Insights({ ctx }) {
  const { data, error, loading, reload } = useData(
    () => rpc("dash_insights", { p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to }),
    [ctx.inst, ctx.from, ctx.to]
  );
  const [open, setOpen] = useState(null);
  const [run, setRun] = useState({ busy: false, msg: null });
  const batch = useData(() => rpc("ai_batch_status"), []);

  async function analyze() {
    setRun({ busy: true, msg: null });
    try {
      const r = await analyzeNow();
      const msg = r.skipped
        ? "Já há um lote em análise. Os resultados aparecem quando ele terminar."
        : r.submitted
          ? `${r.submitted} atendimento(s) enviados para análise. Os resultados costumam aparecer em até 1 hora.`
          : "Nenhum atendimento novo para analisar.";
      setRun({ busy: false, msg });
      batch.reload();
      reload();
    } catch (e) {
      setRun({ busy: false, msg: `Erro: ${e.message}` });
    }
  }

  if (!data) return <>{loading && <Empty>Carregando…</Empty>}<ErrorBox error={error} /></>;
  const sent = data.sentiments || {};
  const sentTotal = Object.values(sent).reduce((a, b) => a + Number(b), 0);
  const pend = data.pending_on || {};

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="row between wrap">
        <p className="note">
          A IA lê cada atendimento encerrado (sem mensagens há 1h) e classifica motivo, clima do cliente, se foi resolvido e a
          qualidade das respostas do time. Os atendimentos são enviados em lote às 11h e às 16h; os resultados aparecem em até 1 hora.
          {batch.data && (
            <> Último envio: {fmtDateTime(batch.data.created_at)} ({fmtNum(batch.data.count)} atendimentos
              {batch.data.status === "open" ? ", em análise" : `, ${fmtNum(batch.data.result?.saved ?? 0)} analisados`}).</>
          )}
        </p>
        {ctx.isAdmin && (
          <button className="btn" onClick={analyze} disabled={run.busy}>{run.busy ? "Enviando…" : "✨ Enviar para análise agora"}</button>
        )}
      </div>
      {run.msg && <div className="callout">{run.msg}</div>}

      <div className="kpis">
        <Kpi label="Atendimentos analisados" value={`${fmtNum(data.analyzed)} / ${fmtNum(data.total)}`} />
        <Kpi label="Resolvidos" value={fmtPct(data.resolved_pct)} tone={data.resolved_pct >= 80 ? "good" : data.resolved_pct >= 60 ? "warn" : "bad"} />
        <Kpi label="Qualidade média do time" value={data.avg_quality == null ? "—" : `${data.avg_quality}/10`} />
        <Kpi label="Satisfação estimada" value={data.avg_satisfaction == null ? "—" : `${data.avg_satisfaction}/5`} />
        <Kpi label="“Estamos verificando” sem retorno" value={fmtNum(data.holding_replies)} tone={data.holding_replies > 0 ? "warn" : "good"} />
        <Kpi label="Próximo passo é do time" value={fmtNum(pend.equipe || 0)} sub={`${fmtNum(pend.cliente || 0)} aguardam o cliente`} />
      </div>

      {data.analyzed === 0 ? (
        <Card><Empty>Nenhum atendimento analisado no período ainda.</Empty></Card>
      ) : (
        <>
          <div className="grid g2">
            <Card title="Motivos de contato">
              <HBars rows={data.categories} label={(r) => r.category} format={fmtNum} />
            </Card>
            <Card title="Clima dos clientes">
              <div className="stackbar">
                {["positivo", "neutro", "negativo", "irritado"].map((s) =>
                  sent[s] ? <span key={s} className={`sb-${s}`} style={{ flex: Number(sent[s]) }} title={`${SENTIMENT[s].label}: ${sent[s]}`} /> : null
                )}
              </div>
              <div className="legend">
                {["positivo", "neutro", "negativo", "irritado"].map((s) => (
                  <span key={s}><i className={`sb-${s}`} />{SENTIMENT[s].label} {fmtPct(sentTotal ? (100 * (sent[s] || 0)) / sentTotal : 0)}</span>
                ))}
              </div>
              <h3>Assuntos mais frequentes</h3>
              <div className="chips">{data.topics.map((t) => <span key={t.topic} className="chip">{t.topic} <b>{t.n}</b></span>)}</div>
            </Card>
          </div>

          <Card title="Precisam de atenção" hint="Clientes insatisfeitos ou demandas não resolvidas">
            {data.attention.length === 0 ? <Empty>Nada crítico no período. 🎉</Empty> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Grupo</th><th>Quando</th><th>Motivo</th><th>Clima</th><th>Resumo</th><th>Pendente com</th></tr></thead>
                  <tbody>
                    {data.attention.map((a) => (
                      <tr key={a.conversation_id} className="click" onClick={() => setOpen(a)}>
                        <td><b>{a.group_name}</b><div className="sub">{a.instance_name}</div></td>
                        <td>{fmtDateTime(a.started_at)}</td>
                        <td>{a.category}</td>
                        <td><Pill cls={SENTIMENT[a.sentiment]?.cls}>{SENTIMENT[a.sentiment]?.label}</Pill></td>
                        <td className="msg">{a.summary}</td>
                        <td>{a.pending_on === "equipe" ? <Pill cls="p-r">time</Pill> : a.pending_on === "cliente" ? <Pill>cliente</Pill> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid g2">
            <Card title="Qualidade por pessoa (IA)">
              {data.team_feedback.length === 0 ? <Empty>Sem avaliações.</Empty> : (
                <div className="fb-list">
                  {data.team_feedback.map((f) => (
                    <div key={f.attendant_id || f.name} className="fb-item">
                      <div className="row between"><b>{f.name}</b><span><b>{f.score}</b>/10 · {f.n} atend.</span></div>
                      <div className="sub good-t">+ {[...new Set(f.strengths)].join(" · ")}</div>
                      <div className="sub bad-t">△ {[...new Set(f.improve)].join(" · ")}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Problemas encontrados no atendimento">
              {data.issues.length === 0 ? <Empty>Nenhum problema apontado.</Empty> : (
                <ul className="list">
                  {data.issues.map((i, k) => (
                    <li key={k} className="click" onClick={() => setOpen(i)}>
                      {i.issue}<div className="sub">{i.group_name} · {fmtDateTime(i.started_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="O que os clientes perguntam" hint="Base para montar um FAQ / respostas prontas">
            <ul className="list cols">
              {data.questions.map((q, k) => (
                <li key={k} className="click" onClick={() => setOpen(q)}>“{q.question}”<div className="sub">{q.group_name}</div></li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {open && <Thread conversationId={open.conversation_id} title={open.group_name} onClose={() => setOpen(null)} />}
    </div>
  );
}
