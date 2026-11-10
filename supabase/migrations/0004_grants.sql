-- =====================================================================
-- Permissões (específico do Supabase: papéis anon / authenticated / service_role)
-- =====================================================================

revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;

grant execute on function
  public.whoami(),
  public.dash_overview(text, timestamptz, timestamptz),
  public.dash_pending(text),
  public.dash_team(text, timestamptz, timestamptz),
  public.dash_groups(text, timestamptz, timestamptz),
  public.list_conversations(text, timestamptz, timestamptz, uuid, text, text, text, int, int),
  public.get_messages(uuid, uuid, int),
  public.dash_insights(text, timestamptz, timestamptz),
  public.list_instances(),
  public.save_instance(jsonb),
  public.list_attendants(),
  public.save_attendant(jsonb),
  public.delete_attendant(uuid),
  public.admin_rebuild_group(uuid),
  public.admin_all_group_ids(),
  public.unknown_senders(text, int),
  public.save_group(jsonb),
  public.resolve_waiting(uuid),
  public.get_settings(),
  public.save_settings(jsonb),
  public.list_users(),
  public.set_user_role(uuid, text)
to authenticated;

grant execute on function
  public.ingest_zapi(text, text, jsonb),
  public.ai_pending_conversations(int, int),
  public.ai_save_analysis(uuid, jsonb, text),
  public.recompute_sla(timestamptz)
to service_role;

-- Funções criadas depois não ficam abertas por padrão
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
