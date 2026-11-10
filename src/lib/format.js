export function fmtDur(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const s = Math.round(Number(sec));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h${String(rm).padStart(2, "0")}` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR"));
export const fmtPct = (n) => (n == null ? "—" : `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);

const TZ = "America/Sao_Paulo";
export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

export function ago(iso) {
  if (!iso) return "nunca";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "agora";
  return `há ${fmtDur(s)}`;
}

export function periodRange(key, custom) {
  const now = new Date();
  const startOfDay = (d) => {
    const x = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
    const offset = d.getTime() - x.getTime();
    x.setHours(0, 0, 0, 0);
    return new Date(x.getTime() + offset);
  };
  const to = new Date(now.getTime() + 60e3);
  if (key === "hoje") return { from: startOfDay(now), to };
  if (key === "ontem") {
    const t = startOfDay(now);
    return { from: new Date(t.getTime() - 86400e3), to: t };
  }
  if (key === "custom" && custom?.from && custom?.to)
    return { from: new Date(`${custom.from}T00:00:00-03:00`), to: new Date(`${custom.to}T23:59:59-03:00`) };
  const days = { "7d": 7, "30d": 30, "90d": 90 }[key] ?? 7;
  return { from: new Date(startOfDay(now).getTime() - (days - 1) * 86400e3), to };
}

export const SENTIMENT = {
  positivo: { label: "Positivo", cls: "p-g" },
  neutro: { label: "Neutro", cls: "p-n" },
  negativo: { label: "Negativo", cls: "p-a" },
  irritado: { label: "Irritado", cls: "p-r" },
};
