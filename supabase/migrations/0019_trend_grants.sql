revoke execute on function public.trend_rows(text, timestamptz, text), public.dash_trend(text, int) from public, anon, authenticated;
grant execute on function public.dash_trend(text, int) to authenticated, service_role;
grant execute on function public.trend_rows(text, timestamptz, text) to service_role;
