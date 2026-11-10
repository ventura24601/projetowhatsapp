// Revisão de casos com IA às 9h, 13h e 17h (horário de Brasília = UTC-3): aberto ou encerrado.
import { submitCaseBatch } from "../lib/cases.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await submitCaseBatch(adminRpc);
  console.log("[cases:submit]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 12,16,20 * * *" };
