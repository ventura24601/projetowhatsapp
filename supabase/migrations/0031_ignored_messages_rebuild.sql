-- Lista de grupos cujo histórico ainda não reflete a lista de mensagens ignoradas
-- (usada pelo script de manutenção, que recalcula um grupo por vez via rebuild_group).
create or replace function public.svc_ignore_pending_groups()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(distinct m.group_id), '[]'::jsonb) from public.messages m
   where public.is_ignored_message(m.content) <> (m.author_type = 'sistema')
$$;
