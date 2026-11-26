revoke execute on function public.svc_ignore_pending_groups() from public, anon, authenticated;
grant execute on function public.svc_ignore_pending_groups(), public.rebuild_group(uuid) to service_role;
