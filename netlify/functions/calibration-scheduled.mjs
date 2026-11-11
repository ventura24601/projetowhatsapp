// Calibragem semanal: toda segunda-feira às 8h (Brasília = UTC-3), avaliando os últimos 30 dias.
import { submitCalibrationBatch } from "../lib/calibration.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async () => {
  const result = await submitCalibrationBatch(adminRpc);
  console.log("[calibration:submit]", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "0 11 * * 1" };
