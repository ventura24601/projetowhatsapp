revoke all on public.calibrations from anon, authenticated;
revoke execute on function public.ai_calibration_candidates(int, int, int), public.ai_save_calibrations(jsonb),
  public.dash_calibration(text) from public, anon, authenticated;
grant execute on function public.ai_calibration_candidates(int, int, int), public.ai_save_calibrations(jsonb) to service_role;
grant execute on function public.dash_calibration(text) to authenticated, service_role;
