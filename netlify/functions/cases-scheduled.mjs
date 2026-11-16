// Revisão de casos com IA de segunda a sexta, às 7h (horário de Brasília = UTC-3): aberto ou encerrado.
import { submitCaseBatch } from "../lib/cases.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await submitCaseBatch(adminRpc);
  console.log("[cases:submit]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 10 * * 1-5" };
