revoke execute on function public.is_ignored_message(text), public.ignore_affected_groups(),
  public.save_ignore_prefixes(jsonb), public.ignore_overview() from public, anon, authenticated;
grant execute on function public.ignore_affected_groups(), public.save_ignore_prefixes(jsonb), public.ignore_overview()
  to authenticated, service_role;
