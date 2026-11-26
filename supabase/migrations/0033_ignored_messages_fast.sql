-- Busca dos grupos afetados mais rápida: só testa mensagens cujo 1º caractere bate com algum texto
-- da lista (ou que já estão como 'sistema'), em vez de normalizar todas as mensagens.
create or replace function public.ignore_candidates()
returns table (group_id uuid) language sql stable set search_path = public as $$
  with f as (select array_agg(distinct left(ltrim(x), 1)) as c
               from public.app_settings s, unnest(s.ignore_prefixes) x where s.id = 1 and trim(x) <> '')
  select distinct m.group_id from public.messages m, f
   where (m.author_type = 'sistema' or left(ltrim(m.content), 1) = any(f.c))
     and public.is_ignored_message(m.content) <> (m.author_type = 'sistema')
$$;

create or replace function public.svc_ignore_pending_groups()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(group_id), '[]'::jsonb) from public.ignore_candidates()
$$;

create or replace function public.ignore_affected_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return (select coalesce(jsonb_agg(group_id), '[]'::jsonb) from public.ignore_candidates());
end $$;

