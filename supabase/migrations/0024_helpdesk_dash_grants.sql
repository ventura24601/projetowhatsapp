revoke execute on function public.dash_helpdesk(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.dash_helpdesk(text, timestamptz, timestamptz) to authenticated, service_role;
