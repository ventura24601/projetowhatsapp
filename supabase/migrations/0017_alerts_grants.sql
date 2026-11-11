revoke execute on function public.dash_alerts(text), public.alert_ack(uuid, text), public.alert_unack(uuid) from public, anon;
grant execute on function public.dash_alerts(text), public.alert_ack(uuid, text), public.alert_unack(uuid) to authenticated, service_role;
