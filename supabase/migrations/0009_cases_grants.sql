-- Permissões dos casos e dos lotes com tipo.
revoke execute on function
  public.case_reopen_on_message(), public.case_close_internal(uuid, text),
  public.ai_batch_open(text), public.ai_batch_create(text, jsonb, text),
  public.ai_case_candidates(int, int), public.ai_save_cases(jsonb, timestamptz),
  public.case_set(uuid, text), public.dash_cases(text)
from public, anon, authenticated;

grant execute on function
  public.ai_batch_open(text), public.ai_batch_create(text, jsonb, text),
  public.ai_case_candidates(int, int), public.ai_save_cases(jsonb, timestamptz)
to service_role;

grant execute on function public.case_set(uuid, text), public.dash_cases(text) to authenticated, service_role;
