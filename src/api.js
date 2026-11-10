import { createClient } from "@supabase/supabase-js";

export const DEMO = import.meta.env.VITE_DEMO === "1" || !import.meta.env.VITE_SUPABASE_URL;

export const supabase = DEMO
  ? null
  : createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

export async function rpc(fn, args = {}) {
  if (DEMO) {
    const r = await fetch(`/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || "Erro");
    return data;
  }
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function analyzeNow() {
  const headers = { "content-type": "application/json" };
  if (!DEMO) {
    const { data } = await supabase.auth.getSession();
    headers.authorization = `Bearer ${data.session?.access_token}`;
  }
  const r = await fetch("/api/analyze-now", { method: "POST", headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || data.message || "Falha ao analisar");
  return data;
}

export function webhookUrl(inst) {
  const base = import.meta.env.VITE_PUBLIC_URL || window.location.origin;
  return `${base}/api/zapi/${inst.slug}?token=${inst.webhook_secret}`;
}
