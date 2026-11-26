-- =====================================================================
-- Mensagens ignoradas: relatórios automáticos que sistemas disparam nos grupos
-- ("*RELATÓRIO DIÁRIO…", "*INFORMAÇÕES GERAIS*", "*Ramal 2126 - …", "*CRC Comercial*").
-- Mensagem que começa com um dos textos configurados vira author_type = 'sistema':
-- fica visível no histórico do grupo, mas fora de TODAS as contas (cliente, time, espera, SLA,
-- atendimentos, IA, alertas e chamados). A lista é editável em Cadastros → Mensagens ignoradas.
-- =====================================================================

alter table public.app_settings
  add column if not exists ignore_prefixes text[] not null
  default array['*RELATÓRIO', '*INFORMAÇÕES GERAIS', '*Ramal ', '*CRC '];

alter table public.messages drop constraint if exists messages_author_type_check;
alter table public.messages add constraint messages_author_type_check
  check (author_type in ('cliente', 'atendente', 'supervisor', 'helpdesk', 'sistema'));

-- A mensagem começa com algum texto da lista? (sem diferenciar acento/maiúscula, ignora espaços no início)
create or replace function public.is_ignored_message(p text)
returns boolean language sql stable set search_path = public as $$
  select coalesce(p, '') <> '' and exists (
    select 1 from public.app_settings s, unnest(s.ignore_prefixes) x
     where s.id = 1 and trim(x) <> ''
       and left(public.norm_text(ltrim(p)), length(public.norm_text(ltrim(x)))) = public.norm_text(ltrim(x)))
$$;

create or replace function pg_temp.patch_fn(p_name text, p_old text, p_new text)
returns void language plpgsql as $$
declare r record; v_src text; n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname = p_name loop
    v_src := pg_get_functiondef(r.oid);
    if position(p_old in v_src) > 0 then
      execute replace(v_src, p_old, p_new);
      n := n + 1;
    end if;
  end loop;
  if n = 0 then raise exception 'patch_fn: trecho não encontrado em %', p_name; end if;
end $$;

-- Entrada: classifica como 'sistema'.
select pg_temp.patch_fn('ingest_zapi',
  $x$    v_author, v_att, v_type, v_content, not public.is_ack_message(v_type, v_content), v_sent)$x$,
  $x$    case when public.is_ignored_message(v_content) then 'sistema' else v_author end,
    v_att, v_type, v_content, not public.is_ack_message(v_type, v_content), v_sent)$x$);
-- Reprocessamento: idem.
select pg_temp.patch_fn('rebuild_group',
  $x$author_type  = case when m.from_me then 'supervisor'$x$,
  $x$author_type  = case when public.is_ignored_message(m.content) then 'sistema'
                             when m.from_me then 'supervisor'$x$);
-- Linha do tempo: mensagem de sistema não abre atendimento, não mexe em espera nem em "última mensagem".
select pg_temp.patch_fn('apply_message',
  $x$if m.id is null then return; end if;$x$,
  $x$if m.id is null or m.author_type = 'sistema' then return; end if;$x$);

-- Grupos cujo histórico precisa ser recalculado depois de mudar a lista.
create or replace function public.ignore_affected_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return coalesce((select jsonb_agg(distinct m.group_id) from public.messages m
                    where public.is_ignored_message(m.content) <> (m.author_type = 'sistema')), '[]'::jsonb);
end $$;

-- Salva a lista e devolve os grupos a recalcular.
create or replace function public.save_ignore_prefixes(p_prefixes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.app_settings
     set ignore_prefixes = array(select distinct trim(x) from jsonb_array_elements_text(coalesce(p_prefixes, '[]'::jsonb)) x where trim(x) <> ''),
         updated_at = now()
   where id = 1;
  return public.ignore_affected_groups();
end $$;

-- Resumo para a tela: lista, quantas mensagens foram ignoradas e exemplos.
create or replace function public.ignore_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return jsonb_build_object(
    'prefixes', (select to_jsonb(ignore_prefixes) from public.app_settings where id = 1),
    'count_30d', (select count(*) from public.messages where author_type = 'sistema' and sent_at > now() - interval '30 days'),
    'groups_30d', (select count(distinct group_id) from public.messages where author_type = 'sistema' and sent_at > now() - interval '30 days'),
    'samples', coalesce((select jsonb_agg(x order by x.sent_at desc) from (
       select m.sent_at, g.name as group_name, left(m.content, 160) as text
         from public.messages m join public.groups g on g.id = m.group_id
        where m.author_type = 'sistema' order by m.sent_at desc limit 8) x), '[]'::jsonb));
end $$;
