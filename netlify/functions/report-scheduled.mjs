// Relatório para gestores de segunda a sexta, às 9h (segunda cobre o fim de semana) (horário de Brasília = UTC-3), enviado ao n8n.
// Sai depois da revisão de casos das 7h, já com os casos atualizados.
import { sendReport } from "../lib/report.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await sendReport(adminRpc, "manha");
  console.log("[report]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 12 * * 1-5" };
