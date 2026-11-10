// Roda a cada 30 min: analisa com IA os atendimentos encerrados (sem mensagens há 1h).
import { runAnalysisBatch } from "../lib/analyze.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await runAnalysisBatch(adminRpc, { limit: Number(process.env.AI_BATCH_SIZE || 25) });
  console.log("[analyze] ", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "*/30 * * * *" };
