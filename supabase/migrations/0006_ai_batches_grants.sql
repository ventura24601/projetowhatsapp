-- Permissões da análise em lote (fica separado: os papéis do Supabase não existem no Postgres local).
revoke all on public.ai_batches from anon, authenticated;
revoke execute on function public.ai_batch_open(), public.ai_batch_create(text, jsonb), public.ai_save_analyses(jsonb),
  public.ai_batch_close(text, jsonb), public.ai_batch_status() from public, anon, authenticated;
grant execute on function public.ai_batch_open(), public.ai_batch_create(text, jsonb), public.ai_save_analyses(jsonb),
  public.ai_batch_close(text, jsonb) to service_role;
grant execute on function public.ai_batch_status() to authenticated, service_role;
