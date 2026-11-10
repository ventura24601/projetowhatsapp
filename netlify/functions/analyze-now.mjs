// Botão "Enviar para análise agora" do painel (somente admin): envia o lote fora do horário.
import { collectAnalysisBatches, submitAnalysisBatch } from "../lib/analyze.mjs";
import { adminRpc, requireAdminFromRequest } from "../lib/supabase.mjs";

export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const me = await requireAdminFromRequest(request);
  if (!me) return Response.json({ ok: false, error: "Apenas administradores." }, { status: 403 });
  await collectAnalysisBatches(adminRpc);
  return Response.json(await submitAnalysisBatch(adminRpc));
};

export const config = { path: "/api/analyze-now" };
