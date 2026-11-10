// Postgres embutido (PGlite) com as migrations do Supabase — usado em testes e no modo demo local.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Simula o schema "auth" do Supabase: o usuário atual vem de settings da sessão.
const AUTH_STUB = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('email', nullif(current_setting('app.email', true), '')) $$;
`;

export const DEMO_USER = { id: "00000000-0000-4000-8000-000000000001", email: "admin@demo.local" };

export async function createLocalDb({ dataDir } = {}) {
  const db = new PGlite(dataDir);
  await db.exec(AUTH_STUB);
  const dir = join(root, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (f.includes("grants")) continue; // papéis do Supabase não existem localmente
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}

export async function asUser(db, user) {
  await db.query(`select set_config('app.uid', $1, false), set_config('app.email', $2, false)`, [
    user?.id ?? "",
    user?.email ?? "",
  ]);
}

// Chama uma função RPC com argumentos nomeados (como o PostgREST faz).
export async function rpc(db, fn, args = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error("invalid function name");
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  const params = keys.map((k, i) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error("invalid arg name");
    return `${k} => $${i + 1}`;
  });
  const values = keys.map((k) =>
    args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]
  );
  const res = await db.query(`select public.${fn}(${params.join(", ")}) as r`, values);
  return res.rows[0]?.r ?? null;
}
