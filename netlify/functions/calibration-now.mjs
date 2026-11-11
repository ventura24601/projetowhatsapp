// Botão "Calibrar agora" da tela Calibragem (somente admin).
import { collectAnalysisBatches } from "../lib/analyze.mjs";
import { submitCalibrationBatch } from "../lib/calibration.mjs";
import { adminRpc, requireAdminFromRequest } from "../lib/supabase.mjs";

export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const me = await requireAdminFromRequest(request);
  if (!me) return Response.json({ ok: false, error: "Apenas administradores." }, { status: 403 });
  await collectAnalysisBatches(adminRpc);
  return Response.json(await submitCalibrationBatch(adminRpc));
};

export const config = { path: "/api/calibration-now" };
