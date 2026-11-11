import { useEffect, useMemo, useState } from "react";
import { DEMO, supabase, rpc } from "./api.js";
import { periodRange } from "./lib/format.js";
import { Seg, useData } from "./components/ui.jsx";
import Login, { ChangePassword, NoAccess } from "./views/Login.jsx";
import Overview from "./views/Overview.jsx";
import Pending from "./views/Pending.jsx";
import Team from "./views/Team.jsx";
import Groups from "./views/Groups.jsx";
import Conversations from "./views/Conversations.jsx";
import Insights from "./views/Insights.jsx";
import Settings from "./views/Settings.jsx";
import Alerts from "./views/Alerts.jsx";
import Calibration from "./views/Calibration.jsx";

const VIEWS = [
  { id: "geral", icon: "📊", label: "Visão geral", C: Overview },
  { id: "pend", icon: "⏳", label: "Aguardando resposta", C: Pending },
  { id: "alerta", icon: "🚨", label: "Alerta", C: Alerts },
  { id: "time", icon: "👥", label: "Equipe", C: Team },
  { id: "calib", icon: "🎯", label: "Calibragem", C: Calibration },
  { id: "grupos", icon: "💬", label: "Grupos", C: Groups },
  { id: "conv", icon: "🗂️", label: "Atendimentos", C: Conversations },
  { id: "ia", icon: "✨", label: "Análise (IA)", C: Insights },
  { id: "config", icon: "⚙️", label: "Cadastros", C: Settings },
];

const PERIODS = [
  { value: "hoje", label: "Hoje" },
  { value: "ontem", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "custom", label: "Período" },
];

const readHash = () => {
  const p = new URLSearchParams(window.location.hash.slice(1));
  return { view: p.get("v") || "geral", inst: p.get("p") || "", period: p.get("t") || "7d" };
};

export default function App() {
  const [session, setSession] = useState(DEMO ? { demo: true } : undefined);
  useEffect(() => {
    if (DEMO) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="boot">Carregando…</div>;
  if (!session) return <Login />;
  return <Shell />;
}

function Shell() {
  const init = readHash();
  const [view, setView] = useState(init.view);
  const [inst, setInst] = useState(init.inst);
  const [period, setPeriod] = useState(init.period);
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [navOpen, setNavOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const me = useData(() => rpc("whoami"), []);
  const instances = useData(() => rpc("list_instances"), []);
  const pending = useData(() => rpc("dash_pending", { p_instance: inst || null }), [inst], { refreshMs: 60000 });
  const alerts = useData(() => rpc("dash_alerts", { p_instance: inst || null }), [inst], { refreshMs: 120000 });

  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      setView(h.view);
      setInst(h.inst);
      setPeriod(h.period);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const p = new URLSearchParams({ v: view, t: period });
    if (inst) p.set("p", inst);
    window.history.replaceState(null, "", `#${p}`);
  }, [view, inst, period]);

  const range = useMemo(() => periodRange(period, custom), [period, custom]);
  const ctx = {
    inst: inst || null,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    isAdmin: me.data?.role === "admin",
    instances: instances.data || [],
    reloadInstances: instances.reload,
    reloadPending: pending.reload,
    reloadAlerts: alerts.reload,
    go: (v) => { setView(v); setNavOpen(false); },
  };
  if (!DEMO && me.data && !me.data.role) return <NoAccess email={me.data.email} />;
  const Current = (VIEWS.find((v) => v.id === view) || VIEWS[0]).C;
  const waiting = pending.data?.length ?? 0;
  const late = pending.data?.filter((p) => p.breached).length ?? 0;
  const critical = alerts.data?.counts?.critico ?? 0;

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <aside>
        <div className="brand">
          Monitor WhatsApp<small>Tempo de resposta do atendimento</small>
        </div>
        <nav className="nav">
          {VIEWS.filter((v) => v.id !== "config" || ctx.isAdmin).map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => ctx.go(v.id)}>
              <span aria-hidden>{v.icon}</span>
              {v.label}
              {v.id === "pend" && waiting > 0 && <span className={`cnt ${late ? "late" : ""}`}>{waiting}</span>}
              {v.id === "alerta" && critical > 0 && <span className="cnt late" title="Alertas críticos">{critical}</span>}
            </button>
          ))}
        </nav>
        <div className="aside-foot">
          {(instances.data || []).map((i) => (
            <div key={i.id} className="inst-status" title={i.last_event_at ? `Último evento ${new Date(i.last_event_at).toLocaleString("pt-BR")}` : "Nenhum evento recebido"}>
              <i className={i.last_event_at && Date.now() - new Date(i.last_event_at) < 6 * 3600e3 ? "on" : ""} />
              {i.name}
            </div>
          ))}
          <div className="foot-row">
            {!DEMO && <button onClick={() => setPwOpen(true)}>Trocar senha</button>}
            {!DEMO && <button onClick={() => supabase.auth.signOut()}>Sair</button>}
          </div>
          <small>{DEMO ? "Modo demonstração (dados simulados)" : me.data?.name || me.data?.email}</small>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}

      <main>
        <div className="top">
          <button className="btn ghost menu" onClick={() => setNavOpen(true)} aria-label="Menu">☰</button>
          <h1>{VIEWS.find((v) => v.id === view)?.label}</h1>
          <div className="filters">
            <Seg
              value={inst}
              onChange={setInst}
              options={[{ value: "", label: "Todos" }, ...(instances.data || []).map((i) => ({ value: i.slug, label: i.name }))]}
            />
            {view !== "pend" && view !== "config" && (
              <>
                <Seg value={period} onChange={setPeriod} options={PERIODS} />
                {period === "custom" && (
                  <span className="dates">
                    <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
                    <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <Current ctx={ctx} pending={pending} />
      </main>
    </div>
  );
}
