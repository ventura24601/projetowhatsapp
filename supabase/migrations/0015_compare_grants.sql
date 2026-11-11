revoke execute on function public.dash_compare(timestamptz, timestamptz) from public, anon;
grant execute on function public.dash_compare(timestamptz, timestamptz) to authenticated, service_role;
