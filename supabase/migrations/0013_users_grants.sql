-- Cadastro de usuários: gravação só pelo servidor (service role); renomear pelo admin.
revoke execute on function public.user_save(uuid, text, text, text), public.user_remove(uuid),
  public.set_user_name(uuid, text) from public, anon, authenticated;
grant execute on function public.user_save(uuid, text, text, text), public.user_remove(uuid) to service_role;
grant execute on function public.set_user_name(uuid, text) to authenticated, service_role;
grant execute on function public.whoami() to authenticated;
