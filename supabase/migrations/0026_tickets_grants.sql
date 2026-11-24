revoke execute on function public.ticket_register(uuid, text, text, text), public.tickets_on_message(),
  public.ai_save_tickets(jsonb), public.dash_tickets(text), public.ticket_set(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.dash_tickets(text), public.ticket_set(uuid, text, text) to authenticated, service_role;
grant execute on function public.ai_save_tickets(jsonb), public.ticket_register(uuid, text, text, text) to service_role;
