import { useEffect, useState } from "react";
import { rpc } from "../api.js";
import { fmtDur, fmtDateTime, SENTIMENT } from "../lib/format.js";
import { Card, Empty, ErrorBox, InstanceTag, Pill, useData } from "../components/ui.jsx";
import Thread from "./Thread.jsx";

const PAGE = 40;

export default function Conversations({ ctx }) {
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const settings = useData(() => rpc("get_settings"), []);

  useEffect(() => {
    const t = setTimeout(() => setQ(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(0); }, [ctx.inst, ctx.from, ctx.to, status, category, q]);

  const { data, error, loading } = useData(
    () =>
      rpc("list_conversations", {
        p_instance: ctx.inst, p_from: ctx.from, p_to: ctx.to, p_group: null,
        p_category: category || null, p_status: status || null, p_search: q || null,
        p_limit: PAGE, p_offset: page * PAGE,
      }),
    [ctx.inst, ctx.from, ctx.to, status, category, q, page]
  );
  const items = data?.items || [];
  const total = Number(data?.total || 0);

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="note">
        Um atendimento é uma sequência de mensagens no grupo; ele termina depois de {settings.data?.conversation_gap_minutes ?? 240} min
        sem conversa (e nunca enquanto o cliente espera resposta). A análise por IA roda sobre atendimentos encerrados.
      </p>
      <Card
        title={`${total} atendimentos`}
        action={
          <div className="row wrap">
            <input className="input" placeholder="Buscar texto, grupo ou resumo…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option>
              <option value="aguardando_equipe">Aguardando o time</option>
              <option value="nao_resolvido">Não resolvidos (IA)</option>
              <option value="negativo">Cliente insatisfeito (IA)</option>
              <option value="sem_analise">Ainda sem análise</option>
            </select>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Todas as categorias</option>
              {(settings.data?.categories || []).map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        }
      >
        {items.length === 0 ? (
          <Empty>{loading ? "Carregando…" : "Nenhum atendimento encontrado com esses filtros."}</Empty>
        ) : (
          <div className="conv-list">
            {items.map((c) => (
              <button key={c.id} className="conv" onClick={() => setOpen(c)}>
                <div className="conv-top">
                  <b>{c.group_name}</b>
                  <InstanceTag name={c.instance_name} color={c.instance_color} />
                  <span className="sub">{fmtDateTime(c.started_at)}</span>
                  <span className="grow" />
                  {c.status === "aguardando_equipe" && <Pill cls="p-a">aguardando time</Pill>}
                  {c.category && <Pill cls="p-b">{c.category}</Pill>}
                  {c.sentiment && <Pill cls={SENTIMENT[c.sentiment]?.cls}>{SENTIMENT[c.sentiment]?.label}</Pill>}
                  {c.resolved === false && <Pill cls="p-r">não resolvido</Pill>}
                </div>
                <div className="conv-sum">{c.summary || <span className="sub">Sem análise ainda.</span>}</div>
                <div className="sub">
                  {c.customer_msgs} msgs do cliente · {c.team_msgs} do time · 1ª resposta {fmtDur(c.first_response_seconds)}
                  {c.team?.length ? ` · ${c.team.join(", ")}` : " · time não respondeu"}
                  {c.quality_score != null && ` · qualidade ${c.quality_score}/10`}
                </div>
              </button>
            ))}
          </div>
        )}
        {total > PAGE && (
          <div className="pager">
            <button className="btn ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>← Anteriores</button>
            <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} de {total}</span>
            <button className="btn ghost small" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Próximos →</button>
          </div>
        )}
      </Card>
      {open && <Thread conversationId={open.id} title={open.group_name} onClose={() => setOpen(null)} />}
    </div>
  );
}
