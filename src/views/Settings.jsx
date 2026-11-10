import { useState } from "react";
import { rpc, webhookUrl, DEMO } from "../api.js";
import { ago, fmtNum } from "../lib/format.js";
import { Card, Empty, ErrorBox, Modal, Pill, Seg, useData } from "../components/ui.jsx";

const TABS = [
  { value: "numeros", label: "Números monitorados" },
  { value: "time", label: "Atendentes" },
  { value: "novos", label: "Números não cadastrados" },
  { value: "sla", label: "Expediente e SLA" },
  { value: "users", label: "Usuários" },
];

// Reprocessa grupos (após mudar quem é do time), um por vez, mostrando progresso.
async function rebuild(groupIds, onProgress) {
  for (let i = 0; i < groupIds.length; i++) {
    onProgress?.(i, groupIds.length);
    await rpc("admin_rebuild_group", { p_group: groupIds[i] });
  }
  onProgress?.(groupIds.length, groupIds.length);
}

export default function Settings({ ctx }) {
  const [tab, setTab] = useState("numeros");
  if (!ctx.isAdmin) return <Empty>Apenas administradores acessam os cadastros.</Empty>;
  return (
    <div className="stack">
      <Seg value={tab} onChange={setTab} options={TABS} />
      {tab === "numeros" && <Instances ctx={ctx} />}
      {tab === "time" && <Attendants />}
      {tab === "novos" && <Unknown ctx={ctx} />}
      {tab === "sla" && <SlaSettings />}
      {tab === "users" && <Users />}
    </div>
  );
}

function Instances({ ctx }) {
  const [shown, setShown] = useState({});
  const [err, setErr] = useState(null);
  async function save(i, patch) {
    try {
      await rpc("save_instance", { p: { id: i.id, ...patch } });
      ctx.reloadInstances();
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <>
      <ErrorBox error={err} />
      <p className="note">
        Cada número monitorado é uma instância da Z-API (o número do supervisor que está em todos os grupos). Na Z-API, abra a
        instância → <b>Webhooks</b> → cole a URL abaixo em <b>“Ao receber”</b> e ative <b>“Notificar as enviadas por mim também”</b>,
        para contar as respostas do próprio supervisor.
      </p>
      <div className="grid g2">
        {ctx.instances.map((i) => (
          <Card key={i.id} title={<span className="row"><input type="color" value={i.color} onChange={(e) => save(i, { color: e.target.value })} aria-label="Cor" /> {i.name}</span>}
            hint={`Último evento: ${ago(i.last_event_at)} · ${fmtNum(i.groups)} grupos · ${fmtNum(i.messages_24h)} mensagens em 24h`}
            action={<Pill cls={i.active ? "p-g" : "p-n"}>{i.active ? "ativo" : "pausado"}</Pill>}>
            <div className="form">
              <label>Nome
                <input className="input" defaultValue={i.name} onBlur={(e) => e.target.value !== i.name && save(i, { name: e.target.value })} />
              </label>
              <label>URL do webhook (Z-API → “Ao receber”)
                <div className="row">
                  <input className="input mono" readOnly value={shown[i.id] ? webhookUrl(i) : webhookUrl(i).replace(/token=.*/, "token=••••••••")} />
                  <button className="btn ghost small" onClick={() => setShown({ ...shown, [i.id]: !shown[i.id] })}>{shown[i.id] ? "Ocultar" : "Mostrar"}</button>
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(webhookUrl(i))}>Copiar</button>
                </div>
              </label>
              <div className="sub">Número conectado: {i.connected_phone || "ainda não identificado (aparece no 1º evento)"}</div>
              <label className="check"><input type="checkbox" checked={i.supervisor_is_team} onChange={(e) => save(i, { supervisor_is_team: e.target.checked })} /> Mensagens do supervisor contam como resposta do time</label>
              <label className="check"><input type="checkbox" checked={i.active} onChange={(e) => save(i, { active: e.target.checked })} /> Receber mensagens deste número</label>
              <div>
                <button className="btn ghost small" onClick={() => confirm("Gerar novo token? A URL antiga para de funcionar e precisa ser trocada na Z-API.") && save(i, { regenerate_secret: true })}>Gerar novo token</button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {DEMO && <p className="note">Modo demonstração: a URL acima aponta para o servidor local.</p>}
    </>
  );
}

const EMPTY = { name: "", phone: "", lid: "", area: "", products: [], active: true };

function Attendants() {
  const list = useData(() => rpc("list_attendants"), []);
  const [edit, setEdit] = useState(null);
  const [progress, setProgress] = useState(null);
  return (
    <>
      <p className="note">
        Só os números cadastrados aqui (além do próprio supervisor) contam como “time”. Todo o resto do grupo é tratado
        como cliente. Ao cadastrar ou alterar alguém, o histórico dos grupos dessa pessoa é recalculado.
      </p>
      {progress && <div className="callout">Recalculando grupos… {progress.done}/{progress.total}</div>}
      <Card title={`${list.data?.length ?? 0} atendentes`} action={<button className="btn" onClick={() => setEdit(EMPTY)}>+ Novo atendente</button>}>
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>Nenhum atendente. Cadastre os números do time ou use a aba “Números não cadastrados”.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Nome</th><th>Telefone</th><th>Área</th><th>Produtos</th><th>Msgs 30d</th><th>Visto</th><th /></tr></thead>
              <tbody>
                {(list.data || []).map((a) => (
                  <tr key={a.id} className={a.active ? "" : "muted"}>
                    <td><b>{a.name}</b>{!a.active && <div className="sub">inativo</div>}</td>
                    <td className="mono">{a.phone}</td>
                    <td>{a.area || "—"}</td>
                    <td>{a.products?.length ? a.products.join(", ") : "—"}</td>
                    <td>{fmtNum(a.msgs_30d)}</td>
                    <td>{ago(a.last_seen)}</td>
                    <td><button className="btn small ghost" onClick={() => setEdit(a)}>Editar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && (
        <AttendantForm
          value={edit}
          onClose={() => setEdit(null)}
          onSaved={async (groups) => {
            setEdit(null);
            if (groups?.length) {
              await rebuild(groups, (done, total) => setProgress({ done, total }));
              setProgress(null);
            }
            list.reload();
          }}
        />
      )}
    </>
  );
}

export function AttendantForm({ value, onClose, onSaved }) {
  const [f, setF] = useState({ ...EMPTY, ...value, lid: value.lid ?? "", area: value.area ?? "", products: value.products ?? [] });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const instances = useData(() => rpc("list_instances"), []);
  const toggle = (slug) => setF({ ...f, products: f.products.includes(slug) ? f.products.filter((s) => s !== slug) : [...f.products, slug] });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await rpc("save_attendant", { p: f });
      await onSaved(r.affected_groups);
    } catch (e2) {
      setErr(e2.message);
      setSaving(false);
    }
  }
  async function remove() {
    if (!confirm(`Remover ${f.name}? As mensagens dessa pessoa passam a contar como cliente.`)) return;
    try {
      const r = await rpc("delete_attendant", { p_id: f.id });
      await onSaved(r.affected_groups);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <Modal title={f.id ? `Editar · ${f.name}` : "Novo atendente"} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox error={err} />
        <label>Nome<input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>WhatsApp (com DDD)
          <input className="input" required placeholder="(11) 98765-4321" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <span className="sub">Aceita com ou sem 55 e com ou sem o 9.</span>
        </label>
        <label>Área<input className="input" placeholder="Suporte, CS, Atendimento…" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} /></label>
        <fieldset>
          <legend>Produtos que atende</legend>
          {(instances.data || []).map((i) => (
            <label key={i.slug} className="check"><input type="checkbox" checked={f.products.includes(i.slug)} onChange={() => toggle(i.slug)} /> {i.name}</label>
          ))}
        </fieldset>
        <details>
          <summary>Avançado</summary>
          <label>ID @lid do WhatsApp (opcional)
            <input className="input mono" value={f.lid} onChange={(e) => setF({ ...f, lid: e.target.value })} />
            <span className="sub">Use quando a Z-API não mostrar o telefone da pessoa (privacidade do WhatsApp).</span>
          </label>
        </details>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo</label>
        <div className="form-actions">
          {f.id && <button type="button" className="btn danger ghost" onClick={remove}>Remover</button>}
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Unknown({ ctx }) {
  const list = useData(() => rpc("unknown_senders", { p_instance: ctx.inst, p_days: 30 }), [ctx.inst]);
  const [edit, setEdit] = useState(null);
  const [progress, setProgress] = useState(null);
  return (
    <>
      <p className="note">
        Pessoas que escreveram nos grupos nos últimos 30 dias e hoje contam como cliente. Quem aparece em <b>muitos grupos</b> é
        provavelmente do time — cadastre para entrar nas métricas.
      </p>
      {progress && <div className="callout">Recalculando grupos… {progress.done}/{progress.total}</div>}
      <Card>
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>Nenhum número encontrado.</Empty> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Nome no WhatsApp</th><th>Telefone</th><th>Grupos</th><th>Mensagens</th><th>Números</th><th>Visto</th><th /></tr></thead>
              <tbody>
                {(list.data || []).map((u) => (
                  <tr key={u.key}>
                    <td><b>{u.name || "—"}</b></td>
                    <td className="mono">{u.phone}</td>
                    <td>{u.groups > 2 ? <Pill cls="p-a">{u.groups}</Pill> : u.groups}</td>
                    <td>{fmtNum(u.msgs)}</td>
                    <td>{u.instances?.join(", ")}</td>
                    <td>{ago(u.last_seen)}</td>
                    <td><button className="btn small" onClick={() => setEdit({ name: u.name || "", phone: u.phone, lid: u.lid || "" })}>Cadastrar no time</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && (
        <AttendantForm
          value={edit}
          onClose={() => setEdit(null)}
          onSaved={async (groups) => {
            setEdit(null);
            if (groups?.length) {
              await rebuild(groups, (done, total) => setProgress({ done, total }));
              setProgress(null);
            }
            list.reload();
          }}
        />
      )}
    </>
  );
}

const DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

function SlaSettings() {
  const s = useData(() => rpc("get_settings"), []);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const v = f || s.data;
  if (!v) return <Empty>Carregando…</Empty>;
  const set = (patch) => setF({ ...v, ...patch });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const out = await rpc("save_settings", {
        p: {
          ...v,
          business_start: v.business_start.slice(0, 5),
          business_end: v.business_end.slice(0, 5),
          holidays: (typeof v.holidays === "string" ? v.holidays.split(/[\s,;]+/) : v.holidays).filter(Boolean),
          categories: (typeof v.categories === "string" ? v.categories.split("\n") : v.categories).map((c) => c.trim()).filter(Boolean),
        },
      });
      setF(null);
      s.reload();
      setMsg(`Salvo. Métricas dos últimos 120 dias recalculadas (${out ? "ok" : ""}).`);
    } catch (e2) {
      setMsg(`Erro: ${e2.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Expediente e SLA">
      <form className="form narrow" onSubmit={save}>
        {msg && <div className="callout">{msg}</div>}
        <label>SLA padrão de resposta (minutos)
          <input className="input" type="number" min="1" value={v.default_sla_minutes} onChange={(e) => set({ default_sla_minutes: e.target.value })} />
          <span className="sub">Cada grupo pode ter o seu próprio SLA (aba Grupos → Editar).</span>
        </label>
        <label className="check"><input type="checkbox" checked={v.use_business_hours} onChange={(e) => set({ use_business_hours: e.target.checked })} /> Contar tempo só dentro do expediente</label>
        <div className="row wrap">
          <label>Início<input className="input" type="time" value={v.business_start.slice(0, 5)} onChange={(e) => set({ business_start: e.target.value })} /></label>
          <label>Fim<input className="input" type="time" value={v.business_end.slice(0, 5)} onChange={(e) => set({ business_end: e.target.value })} /></label>
        </div>
        <fieldset>
          <legend>Dias de expediente</legend>
          <div className="row wrap">
            {DAYS.map((d, i) => (
              <label key={d} className="check">
                <input type="checkbox" checked={v.business_days.includes(i + 1)}
                  onChange={(e) => set({ business_days: e.target.checked ? [...v.business_days, i + 1].sort() : v.business_days.filter((x) => x !== i + 1) })} /> {d}
              </label>
            ))}
          </div>
        </fieldset>
        <label>Feriados (AAAA-MM-DD, separados por vírgula)
          <input className="input" value={Array.isArray(v.holidays) ? v.holidays.join(", ") : v.holidays} onChange={(e) => set({ holidays: e.target.value })} />
        </label>
        <label>Silêncio que encerra um atendimento (minutos)
          <input className="input" type="number" min="15" value={v.conversation_gap_minutes} onChange={(e) => set({ conversation_gap_minutes: e.target.value })} />
        </label>
        <label>Categorias usadas pela IA (uma por linha)
          <textarea className="input" rows="8" value={Array.isArray(v.categories) ? v.categories.join("\n") : v.categories} onChange={(e) => set({ categories: e.target.value })} />
        </label>
        <div className="form-actions"><button className="btn" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button></div>
      </form>
    </Card>
  );
}

function Users() {
  const list = useData(() => rpc("list_users"), []);
  const [err, setErr] = useState(null);
  async function setRole(u, role) {
    try {
      await rpc("set_user_role", { p_user: u.user_id, p_role: role });
      list.reload();
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <Card title="Usuários do painel">
      <p className="note">
        Convide pessoas pelo painel do Supabase (Authentication → Users → Invite). O primeiro usuário vira admin; os
        próximos entram como “visualizador” e só veem os relatórios.
      </p>
      <ErrorBox error={err || list.error} />
      <table className="tbl">
        <thead><tr><th>E-mail</th><th>Papel</th><th>Desde</th><th /></tr></thead>
        <tbody>
          {(list.data || []).map((u) => (
            <tr key={u.user_id}>
              <td>{u.email || u.user_id}</td>
              <td>
                <select className="input" value={u.role} onChange={(e) => setRole(u, e.target.value)}>
                  <option value="admin">Admin</option>
                  <option value="viewer">Visualizador</option>
                </select>
              </td>
              <td>{new Date(u.created_at).toLocaleDateString("pt-BR")}</td>
              <td><button className="btn small ghost danger" onClick={() => confirm("Remover acesso?") && setRole(u, "remove")}>Remover</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
