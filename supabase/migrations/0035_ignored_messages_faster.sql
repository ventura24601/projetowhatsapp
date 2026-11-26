-- Os textos da lista são curtos: basta normalizar o começo da mensagem (até 200 caracteres).
create or replace function public.is_ignored_message(p text)
returns boolean language sql stable set search_path = public as $$
  with h as (select public.norm_text(left(ltrim(coalesce(p, '')), 200)) as head)
  select h.head <> '' and exists (
    select 1 from public.app_settings s, unnest(s.ignore_prefixes) x
     where s.id = 1 and trim(x) <> ''
       and left(h.head, length(public.norm_text(ltrim(x)))) = public.norm_text(ltrim(x)))
  from h
$$;

create or replace function public.ignore_candidates()
returns table (group_id uuid) language sql stable set search_path = public as $$
  with p as (select public.norm_text(ltrim(x)) as px
               from public.app_settings s, unnest(s.ignore_prefixes) x where s.id = 1 and trim(x) <> ''),
       f as (select array_agg(distinct left(px, 1)) as c from p),
       c as (select m.group_id, m.author_type, public.norm_text(left(ltrim(m.content), 80)) as head
               from public.messages m, f
              where m.author_type = 'sistema' or left(ltrim(m.content), 1) = any(f.c))
  select distinct c.group_id from c
   where exists (select 1 from p where left(c.head, length(p.px)) = p.px) <> (c.author_type = 'sistema')
$$;
