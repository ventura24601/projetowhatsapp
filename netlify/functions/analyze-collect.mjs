// A cada 20 min confere se o lote enviado terminou e salva as análises. Não chama o modelo.
import { collectAnalysisBatches } from "../lib/analyze.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await collectAnalysisBatches(adminRpc);
  if (result.batches?.length || !result.ok) console.log("[analyze:collect]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "*/20 * * * *" };
