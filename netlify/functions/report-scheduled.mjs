// Relatório para gestores às 11h e às 15h (horário de Brasília = UTC-3), enviado ao n8n.
import { sendReport } from "../lib/report.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
  const result = await sendReport(adminRpc, hour < 13 ? "manha" : "tarde");
  console.log("[report]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 14,18 * * *" };
