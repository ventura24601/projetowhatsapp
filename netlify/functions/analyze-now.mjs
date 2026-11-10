// Botão "Analisar agora" do painel (somente admin).
import { runAnalysisBatch } from "../lib/analyze.mjs";
import { adminRpc, requireAdminFromRequest } from "../lib/supabase.mjs";

export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const me = await requireAdminFromRequest(request);
  if (!me) return Response.json({ ok: false, error: "Apenas administradores." }, { status: 403 });
  const result = await runAnalysisBatch(adminRpc, { limit: 15, idleMinutes: 15 });
  return Response.json(result);
};

export const config = { path: "/api/analyze-now" };
