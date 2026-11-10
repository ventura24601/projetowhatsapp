// Envia o lote de análise por IA às 11h e às 16h (horário de Brasília = UTC-3).
import { submitAnalysisBatch } from "../lib/analyze.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await submitAnalysisBatch(adminRpc);
  console.log("[analyze:submit]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 14,19 * * *" };
