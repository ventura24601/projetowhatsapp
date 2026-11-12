import { useEffect, useRef } from "react";
import { rpc } from "../api.js";
import { fmtDur, fmtDateTime, fmtTime, SENTIMENT } from "../lib/format.js";
import { Modal, useData, Empty, ErrorBox, Pill } from "../components/ui.jsx";

// Conversa completa (de um atendimento ou dos últimos 300 eventos do grupo)
export default function Thread({ conversationId, groupId, title, onClose }) {
  const { data, error } = useData(
    () => rpc("get_messages", { p_conversation: conversationId || null, p_group: groupId || null, p_limit: 300 }),
    [conversationId, groupId]
  );
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [data]);
  const conv = data?.conversation;
  const a = conv?.analysis;

  let lastDay = "";
  return (
    <Modal title={title || conv?.group_name || "Conversa"} onClose={onClose} wide>
      <ErrorBox error={error} />
      {a && (
        <div className="analysis">
          <div className="analysis-tags">
            {conv.category && <Pill cls="p-b">{conv.category}</Pill>}
            {conv.sentiment && <Pill cls={SENTIMENT[conv.sentiment]?.cls}>{SENTIMENT[conv.sentiment]?.label}</Pill>}
            {conv.resolved != null && <Pill cls={conv.resolved ? "p-g" : "p-r"}>{conv.resolved ? "Resolvido" : "Não resolvido"}</Pill>}
            {conv.quality_score != null && <Pill>Qualidade {conv.quality_score}/10</Pill>}
            {conv.first_response_seconds != null && <Pill>1ª resposta {fmtDur(conv.first_response_seconds)}</Pill>}
          </div>
          <p>{conv.summary}</p>
          {a.issues?.length > 0 && <ul className="issues">{a.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {a.team_feedback?.length > 0 && (
            <div className="fb">
              {a.team_feedback.map((f, i) => (
                <div key={i}><b>{f.name}</b> · {f.score}/10 — <span className="good-t">+ {f.strengths}</span> · <span className="bad-t">△ {f.improve}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="chat">
        {!data && <Empty>Carregando…</Empty>}
        {data?.messages.map((m) => {
          const day = fmtDateTime(m.sent_at).slice(0, 5);
          const showDay = day !== lastDay;
          lastDay = day;
          const hd = m.author_type === "helpdesk";
          const team = m.author_type === "atendente" || m.author_type === "supervisor";
          return (
            <div key={m.id}>
              {showDay && <div className="chat-day">{day}</div>}
              <div className={`bubble ${hd ? "hd" : team ? "team" : "cust"}`}>
                <div className="bubble-h">
                  <b>{hd ? m.attendant_name || m.sender_name : team ? m.attendant_name || (m.author_type === "supervisor" ? "Supervisor" : m.sender_name) : m.sender_name || m.sender_phone}</b>
                  {hd && <span className="role">helpdesk · fora das métricas</span>}
                  {team && <span className="role">{m.author_type === "supervisor" ? "supervisor" : "time"}</span>}
                  <span className="t">{fmtTime(m.sent_at)}</span>
                </div>
                <div className="bubble-b">{m.content ?? `[${m.message_type}]`}</div>
                {m.response_seconds != null && (
                  <div className={`resp ${m.sla_breached ? "bad-t" : "good-t"}`}>↳ respondeu em {fmtDur(m.response_seconds)}</div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </Modal>
  );
}
