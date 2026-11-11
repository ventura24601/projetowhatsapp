// Cadastro de usuários do painel (somente admin): criar login, trocar senha, remover.
import { adminRpc, requireAdminFromRequest, supabaseAdmin } from "../lib/supabase.mjs";

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });
const ROLES = ["admin", "viewer"];

async function findByEmail(email) {
  const auth = supabaseAdmin().auth.admin;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await auth.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
    if (u || data.users.length < 200) return u || null;
  }
  return null;
}

export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const me = await requireAdminFromRequest(request);
  if (!me) return fail("Apenas administradores.", 403);
  const b = await request.json().catch(() => ({}));
  const auth = supabaseAdmin().auth.admin;

  try {
    if (b.action === "create") {
      const email = String(b.email || "").trim().toLowerCase();
      const role = ROLES.includes(b.role) ? b.role : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("E-mail inválido.");
      if (String(b.password || "").length < 8) return fail("A senha precisa ter pelo menos 8 caracteres.");
      let { data, error } = await auth.createUser({
        email, password: b.password, email_confirm: true, user_metadata: { name: b.name || null },
      });
      let user = data?.user;
      if (error) {
        // Já existe um login com esse e-mail (ex.: criado antes): reaproveita e define a senha.
        if (!/already|registered|exists/i.test(error.message)) throw error;
        user = await findByEmail(email);
        if (!user) throw error;
        const r = await auth.updateUserById(user.id, { password: b.password, email_confirm: true });
        if (r.error) throw r.error;
      }
      await adminRpc("user_save", { p_user: user.id, p_email: email, p_name: b.name || null, p_role: role });
      return Response.json({ ok: true, user_id: user.id });
    }

    if (b.action === "password") {
      if (String(b.password || "").length < 8) return fail("A senha precisa ter pelo menos 8 caracteres.");
      const { error } = await auth.updateUserById(b.user_id, { password: b.password });
      if (error) throw error;
      return Response.json({ ok: true });
    }

    if (b.action === "remove") {
      if (b.user_id === me.user_id) return fail("Você não pode remover o seu próprio acesso.");
      await adminRpc("user_remove", { p_user: b.user_id });
      const { error } = await auth.deleteUser(b.user_id);
      if (error && !/not found/i.test(error.message)) throw error;
      return Response.json({ ok: true });
    }

    return fail("Ação desconhecida.");
  } catch (e) {
    return fail(e.message || "Erro ao gerenciar usuário.", 500);
  }
};

export const config = { path: "/api/users" };
