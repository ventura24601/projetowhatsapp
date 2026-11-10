import { useEffect, useState, useCallback } from "react";
import { fmtDur } from "../lib/format.js";

// Carrega dados de uma RPC e recarrega quando as dependências mudam.
export function useData(loader, deps, { refreshMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    try {
      const data = await loader();
      setState({ data, error: null, loading: false });
    } catch (e) {
      setState((s) => ({ data: s.data, error: e.message, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { ...state, reload: load };
}

export function Card({ title, hint, action, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-h">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <p className="hint">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone, delta }) {
  return (
    <div className={`kpi ${tone || ""}`}>
      <span className="kpi-l">{label}</span>
      <strong className="kpi-v">{value}</strong>
      {(sub || delta) && (
        <span className="kpi-s">
          {delta}
          {sub}
        </span>
      )}
    </div>
  );
}

// Variação vs período anterior. better = "down" quando menor é melhor (tempo).
export function Delta({ now, prev, better = "up", fmt = (v) => v }) {
  if (now == null || prev == null || Number(prev) === 0) return null;
  const diff = Number(now) - Number(prev);
  if (Math.abs(diff) < 0.0001) return <span className="delta">= </span>;
  const good = better === "up" ? diff > 0 : diff < 0;
  return (
    <span className={`delta ${good ? "good" : "bad"}`} title="Comparado ao período anterior de mesmo tamanho">
      {diff > 0 ? "▲" : "▼"} {fmt(Math.abs(diff))}{" "}
    </span>
  );
}

export function Pill({ children, cls = "p-n", title }) {
  return (
    <span className={`pill ${cls}`} title={title}>
      {children}
    </span>
  );
}

export function SlaPill({ seconds, slaMinutes }) {
  if (seconds == null) return <Pill>—</Pill>;
  const r = Number(seconds) / (slaMinutes * 60);
  const cls = r <= 1 ? "p-g" : r <= 2 ? "p-a" : "p-r";
  return <Pill cls={cls}>{fmtDur(seconds)}</Pill>;
}

export function InstanceTag({ name, color }) {
  return (
    <span className="itag">
      <i style={{ background: color || "var(--muted)" }} />
      {name}
    </span>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error">⚠️ {error}</div>;
}

// Barras horizontais simples
export function HBars({ rows, value = (r) => r.n, label = (r) => r.label, format = (v) => v, color }) {
  const max = Math.max(1, ...rows.map((r) => Number(value(r)) || 0));
  return (
    <div className="hbars">
      {rows.map((r, i) => (
        <div className="hbar" key={i}>
          <span className="hbar-l" title={label(r)}>{label(r)}</span>
          <span className="hbar-t">
            <span
              className="hbar-f"
              style={{ width: `${(100 * (Number(value(r)) || 0)) / max}%`, background: color?.(r) }}
            />
          </span>
          <span className="hbar-v">{format(value(r))}</span>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <header className="modal-h">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Fechar">✕</button>
        </header>
        <div className="modal-b">{children}</div>
      </div>
    </div>
  );
}

export function Seg({ value, onChange, options }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
