import { createClient } from "@supabase/supabase-js";

let admin;
export function supabaseAdmin() {
  if (!admin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados");
    admin = createClient(url, key, { auth: { persistSession: false } });
  }
  return admin;
}

export async function adminRpc(fn, args) {
  const { data, error } = await supabaseAdmin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Valida o JWT do usuário do painel e confirma que é admin.
export async function requireAdminFromRequest(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.rpc("whoami");
  if (error || data?.role !== "admin") return null;
  return data;
}
