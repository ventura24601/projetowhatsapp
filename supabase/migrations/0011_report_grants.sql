-- Permissões do relatório: só o servidor (service role).
revoke all on public.report_log from anon, authenticated;
revoke execute on function public.mgr_report(timestamptz, timestamptz),
  public.report_log_add(text, timestamptz, timestamptz, boolean, int, text) from public, anon, authenticated;
grant execute on function public.mgr_report(timestamptz, timestamptz),
  public.report_log_add(text, timestamptz, timestamptz, boolean, int, text) to service_role;
