-- =====================================================================
-- Helpdesk: time interno que também escreve nos grupos.
-- Quem é cadastrado com time = 'helpdesk' deixa de contar como cliente E como atendente:
--   * não abre espera, não responde espera (não gera tempo de resposta/SLA);
--   * não entra em mensagens do cliente nem do time, nem nas telas Equipe/Calibragem;
--   * continua aparecendo na conversa (e para a IA) identificado como Helpdesk.
-- =====================================================================

alter table public.attendants
  add column if not exists team text not null default 'atendimento'
  check (team in ('atendimento', 'helpdesk'));

alter table public.messages drop constraint if exists messages_author_type_check;
alter table public.messages add constraint messages_author_type_check
  check (author_type in ('cliente', 'atendente', 'supervisor', 'helpdesk'));

-- Tipo de autor de uma mensagem a partir do cadastro encontrado.
create or replace function public.author_for(p_att uuid)
returns text language sql stable set search_path = public as $$
  select case when p_att is null then 'cliente'
              when (select team from public.attendants where id = p_att) = 'helpdesk' then 'helpdesk'
              else 'atendente' end
$$;

-- Ajusta as funções existentes trocando trechos exatos do corpo (falha se o trecho não existir).
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

-- Classificação na entrada e no reprocessamento.
select pg_temp.patch_fn('ingest_zapi',
  $x$case when v_att is null then 'cliente' else 'atendente' end$x$,
  $x$public.author_for(v_att)$x$);
select pg_temp.patch_fn('rebuild_group',
  $x$when public.match_attendant(m.sender_phone, m.sender_lid) is not null then 'atendente'$x$,
  $x$when public.match_attendant(m.sender_phone, m.sender_lid) is not null then public.author_for(public.match_attendant(m.sender_phone, m.sender_lid))$x$);

-- "Mensagens do time" = atendente + supervisor (antes era "tudo que não é cliente").
do $$
declare f text;
begin
  for f in select distinct p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.prokind = 'f'
              and pg_get_functiondef(p.oid) like '%author_type <> ''cliente''%' loop
    perform pg_temp.patch_fn(f, $x$author_type <> 'cliente'$x$, $x$author_type in ('atendente', 'supervisor')$x$);
  end loop;
end $$;

-- Helpdesk fora da tela Equipe e da Calibragem.
select pg_temp.patch_fn('dash_team',
  $x$from public.attendants a
    union all$x$,
  $x$from public.attendants a where a.team = 'atendimento'
    union all$x$);
select pg_temp.patch_fn('ai_calibration_candidates',
  $x$where a.active$x$, $x$where a.active and a.team = 'atendimento'$x$);
select pg_temp.patch_fn('dash_calibration',
  $x$where a.active and$x$, $x$where a.active and a.team = 'atendimento' and$x$);

-- Cadastro: lista e salva o time.
create or replace function public.list_attendants()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.team, t.name) from (
    select a.id, a.name, a.phone, a.lid, a.area, a.products, a.active, a.team, a.created_at,
           (select count(*) from public.messages m where m.attendant_id = a.id and m.sent_at > now() - interval '30 days') as msgs_30d,
           (select max(m.sent_at) from public.messages m where m.attendant_id = a.id) as last_seen
      from public.attendants a) t), '[]'::jsonb);
end $$;

create or replace function public.save_attendant(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_team text := case when p ->> 'team' = 'helpdesk' then 'helpdesk' else 'atendimento' end;
  old public.attendants;
  v_groups uuid[];
begin
  perform public.require_admin();
  if public.phone_key(p ->> 'phone') is null then
    raise exception 'Telefone inválido.';
  end if;
  if v_id is not null then
    select * into old from public.attendants where id = v_id;
  end if;
  if exists (select 1 from public.attendants where phone_key = public.phone_key(p ->> 'phone') and id is distinct from v_id) then
    raise exception 'Já existe um cadastro com esse telefone.';
  end if;

  if v_id is null then
    insert into public.attendants (name, phone, lid, area, products, active, team)
    values (p ->> 'name', p ->> 'phone', nullif(p ->> 'lid', ''), nullif(p ->> 'area', ''),
            coalesce(array(select jsonb_array_elements_text(p -> 'products')), '{}'),
            coalesce((p ->> 'active')::boolean, true), v_team)
    returning id into v_id;
  else
    update public.attendants set
      name = p ->> 'name', phone = p ->> 'phone', lid = nullif(p ->> 'lid', ''), area = nullif(p ->> 'area', ''),
      products = coalesce(array(select jsonb_array_elements_text(p -> 'products')), '{}'),
      active = coalesce((p ->> 'active')::boolean, true), team = v_team
    where id = v_id;
  end if;

  v_groups := public.groups_with_sender(public.phone_key(p ->> 'phone'), nullif(p ->> 'lid', ''));
  if old.id is not null and (old.phone_key is distinct from public.phone_key(p ->> 'phone') or old.lid is distinct from nullif(p ->> 'lid', '')) then
    v_groups := v_groups || public.groups_with_sender(old.phone_key, old.lid);
  end if;
  return jsonb_build_object('id', v_id, 'affected_groups', to_jsonb(array(select distinct unnest(v_groups))));
end $$;
