-- Casos: a IA decide, 3x por dia, se cada atendimento está aberto ou encerrado (pelo cliente,
-- pela equipe ou por não ter demanda). Encerrar um caso também tira o grupo de "Aguardando resposta".

alter table public.conversations
  add column if not exists case_status     text not null default 'aberto' check (case_status in ('aberto', 'encerrado')),
  add column if not exists case_closed_by  text check (case_closed_by in ('cliente', 'equipe', 'sem_demanda', 'manual')),
  add column if not exists case_closed_at  timestamptz,
  add column if not exists case_next_step  text check (case_next_step in ('equipe', 'cliente', 'ninguem')),
  add column if not exists case_reason     text,
  add column if not exists case_confidence text,
  add column if not exists case_checked_at timestamptz,
  add column if not exists case_review     jsonb;

create index if not exists conversations_case_idx on public.conversations (case_status, last_message_at desc);

alter table public.ai_batches
  add column if not exists kind text not null default 'analise' check (kind in ('analise', 'casos'));

-- Nova mensagem do cliente (que pede resposta) depois do encerramento reabre o caso.
create or replace function public.case_reopen_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.conversation_id is not null and new.author_type = 'cliente' and new.opens_wait then
    update public.conversations
       set case_status = 'aberto', case_closed_by = null, case_closed_at = null, case_next_step = 'equipe'
     where id = new.conversation_id and case_status = 'encerrado' and new.sent_at > case_closed_at;
  end if;
  return null;
end $$;

drop trigger if exists messages_case_reopen on public.messages;
create trigger messages_case_reopen
  after update of conversation_id on public.messages
  for each row when (new.conversation_id is distinct from old.conversation_id)
  execute function public.case_reopen_on_message();

-- Encerra o caso e, se o grupo está esperando resposta por causa dele, encerra a espera.
create or replace function public.case_close_internal(p_conversation uuid, p_by text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  update public.conversations
     set case_status = 'encerrado', case_closed_by = p_by, case_closed_at = now(), case_next_step = 'ninguem'
   where id = p_conversation returning * into c;
  if c.id is null then return; end if;
  update public.conversations set status = 'aguardando_cliente' where id = c.id;
  update public.groups g set waiting_since = null, waiting_message_id = null
   where g.id = c.group_id and g.waiting_message_id is not null
     and exists (select 1 from public.messages m where m.id = g.waiting_message_id and m.conversation_id = c.id);
end $$;

-- ---------- Lotes: agora com tipo (análise ou casos) ----------
drop function if exists public.ai_batch_open();
create or replace function public.ai_batch_open(p_kind text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'created_at', created_at, 'rosters', rosters)
                            order by created_at), '[]'::jsonb)
    from public.ai_batches where status = 'open' and (p_kind is null or kind = p_kind);
$$;

drop function if exists public.ai_batch_create(text, jsonb);
create or replace function public.ai_batch_create(p_id text, p_rosters jsonb, p_kind text default 'analise')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_batches (id, kind, conversation_ids, rosters)
  values (p_id, p_kind, array(select k::uuid from jsonb_object_keys(p_rosters) k), p_rosters);
end $$;

create or replace function public.ai_batch_close(p_id text, p_result jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare b public.ai_batches;
begin
  update public.ai_batches set status = 'ended', ended_at = now(), result = p_result
   where id = p_id and status = 'open' returning * into b;
  if b.id is null or b.kind <> 'analise' then return; end if;
  update public.conversations set analyzed_at = b.created_at
   where id = any(b.conversation_ids) and analyzed_at > b.created_at;
end $$;

create or replace function public.ai_batch_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return (select jsonb_build_object('id', id, 'created_at', created_at, 'status', status, 'ended_at', ended_at,
                                    'count', cardinality(conversation_ids), 'result', result)
            from public.ai_batches where kind = 'analise' order by created_at desc limit 1);
end $$;

-- ---------- Revisão de casos ----------
-- Casos abertos com novidade desde a última revisão (últimos p_days dias).
create or replace function public.ai_case_candidates(p_limit int default 500, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((select jsonb_agg(x) from (
    select c.id, c.last_message_at, g.name as group_name, i.name as instance_name,
           exists (select 1 from public.messages wm where wm.id = g.waiting_message_id and wm.conversation_id = c.id) as waiting,
           (select jsonb_agg(jsonb_build_object(
                      'at', mm.sent_at, 'author', mm.author_type, 'attendant_id', mm.attendant_id,
                      'name', coalesce(a.name, case when mm.author_type = 'supervisor' then 'Supervisor' end, mm.sender_name, 'Cliente'),
                      'type', mm.message_type, 'text', left(mm.content, 800)) order by mm.sent_at)
              from (select * from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 60) mm
              left join public.attendants a on a.id = mm.attendant_id) as messages
      from public.conversations c
      join public.groups g on g.id = c.group_id and g.monitored
      join public.instances i on i.id = c.instance_id
     where c.case_status = 'aberto'
       and c.customer_msgs > 0
       and c.last_message_at > now() - make_interval(days => p_days)
       and (c.case_checked_at is null or c.case_checked_at < c.last_message_at)
       and not exists (select 1 from public.ai_batches b
                        where b.status = 'open' and b.kind = 'casos' and c.id = any(b.conversation_ids))
     order by c.last_message_at desc
     limit greatest(1, least(p_limit, 2000))) x), '[]'::jsonb);
end $$;

-- Salva as decisões: p = [{id, decision, model}]. p_checked_at = hora do envio do lote.
-- Só encerra com confiança alta/média e se o cliente não escreveu de novo depois do envio.
create or replace function public.ai_save_cases(p jsonb, p_checked_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; d jsonb; c public.conversations; v_checked int := 0; v_closed int := 0;
begin
  for r in select * from jsonb_array_elements(p) loop
    d := r -> 'decision';
    select * into c from public.conversations where id = (r ->> 'id')::uuid;
    if c.id is null then continue; end if;
    update public.conversations set
      case_checked_at = p_checked_at,
      case_next_step  = d ->> 'next_step',
      case_reason     = d ->> 'reason',
      case_confidence = d ->> 'confidence',
      case_review     = d || jsonb_build_object('model', r ->> 'model', 'checked_at', p_checked_at)
     where id = c.id;
    v_checked := v_checked + 1;
    if c.case_status = 'aberto'
       and d ->> 'status' = 'encerrado'
       and d ->> 'confidence' in ('alta', 'media')
       and d ->> 'closed_by' in ('cliente', 'equipe', 'sem_demanda')
       and not exists (select 1 from public.messages m
                        where m.conversation_id = c.id and m.author_type = 'cliente' and m.opens_wait
                          and m.sent_at > p_checked_at) then
      perform public.case_close_internal(c.id, d ->> 'closed_by');
      v_closed := v_closed + 1;
    end if;
  end loop;
  return jsonb_build_object('checked', v_checked, 'closed', v_closed);
end $$;

-- Encerrar / reabrir manualmente (admin).
create or replace function public.case_set(p_conversation uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_status = 'encerrado' then
    perform public.case_close_internal(p_conversation, 'manual');
    update public.conversations set case_checked_at = now() where id = p_conversation;
  elsif p_status = 'aberto' then
    update public.conversations
       set case_status = 'aberto', case_closed_by = null, case_closed_at = null,
           case_next_step = 'equipe', case_checked_at = now()
     where id = p_conversation;
  else
    raise exception 'status inválido';
  end if;
end $$;

-- "Marcar como resolvido" em Aguardando resposta também encerra o caso.
create or replace function public.resolve_waiting(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_conv uuid;
begin
  perform public.require_admin();
  select m.conversation_id into v_conv from public.messages m
   where m.id = (select waiting_message_id from public.groups where id = p_group);
  update public.groups set waiting_since = null, waiting_message_id = null where id = p_group;
  if v_conv is not null then
    perform public.case_close_internal(v_conv, 'manual');
    update public.conversations set case_checked_at = now() where id = v_conv;
  end if;
end $$;

-- Home: situação dos casos.
create or replace function public.dash_cases(p_instance text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_today timestamptz;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;
  v_today := date_trunc('day', now() at time zone s.timezone) at time zone s.timezone;
  return (
    with c as (
      select c.*, g.name as group_name, i.slug, i.name as instance_name, i.color as instance_color,
             exists (select 1 from public.messages wm where wm.id = g.waiting_message_id and wm.conversation_id = c.id) as waiting
        from public.conversations c
        join public.groups g on g.id = c.group_id and g.monitored
        join public.instances i on i.id = c.instance_id
       where c.customer_msgs > 0 and public.inst_match(p_instance, i.slug)
         and (c.last_message_at > now() - interval '30 days' or c.case_closed_at > now() - interval '30 days')
    )
    select jsonb_build_object(
      'open_team',   (select count(*) from c where case_status = 'aberto' and coalesce(case_next_step, 'equipe') <> 'cliente'),
      'open_client', (select count(*) from c where case_status = 'aberto' and case_next_step = 'cliente'),
      'unchecked',   (select count(*) from c where case_status = 'aberto' and (case_checked_at is null or case_checked_at < last_message_at)),
      'closed_today', (select count(*) from c where case_status = 'encerrado' and case_closed_at >= v_today),
      'closed_7d', coalesce((select jsonb_object_agg(case_closed_by, n) from (
                     select case_closed_by, count(*) n from c
                      where case_status = 'encerrado' and case_closed_at >= now() - interval '7 days' group by 1) x), '{}'::jsonb),
      'last_review', (select jsonb_build_object('created_at', created_at, 'status', status, 'count', cardinality(conversation_ids), 'result', result)
                        from public.ai_batches where kind = 'casos' order by created_at desc limit 1),
      'open_list', coalesce((select jsonb_agg(x) from (
                     select id, group_name, instance_name, instance_color, last_message_at, case_next_step as next_step,
                            case_reason as reason, case_checked_at < last_message_at or case_checked_at is null as unchecked, waiting
                       from c where case_status = 'aberto'
                      order by (coalesce(case_next_step, 'equipe') = 'cliente'), last_message_at desc limit 15) x), '[]'::jsonb),
      'closed_list', coalesce((select jsonb_agg(x) from (
                     select id, group_name, instance_name, instance_color, case_closed_at as closed_at,
                            case_closed_by as closed_by, case_reason as reason
                       from c where case_status = 'encerrado'
                      order by case_closed_at desc limit 10) x), '[]'::jsonb)
    ));
end $$;

-- Reprocessar o grupo preserva também o estado do caso.
create or replace function public.rebuild_group(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  create temp table if not exists _ai_keep (like public.conversations including defaults) on commit drop;
  delete from _ai_keep where true;
  insert into _ai_keep select * from public.conversations
   where group_id = p_group and (analyzed_at is not null or case_checked_at is not null or case_status = 'encerrado');

  update public.messages m
     set attendant_id = case when m.from_me then null else public.match_attendant(m.sender_phone, m.sender_lid) end,
         author_type  = case when m.from_me then 'supervisor'
                             when public.match_attendant(m.sender_phone, m.sender_lid) is not null then 'atendente'
                             else 'cliente' end,
         conversation_id = null
   where m.group_id = p_group;

  delete from public.response_events where group_id = p_group;
  delete from public.conversations   where group_id = p_group;
  update public.groups set waiting_since = null, waiting_message_id = null, last_message_at = null where id = p_group;

  for r in select id from public.messages where group_id = p_group order by sent_at, received_at loop
    perform public.apply_message(r.id);
    n := n + 1;
  end loop;

  update public.conversations c
     set analyzed_at = k.analyzed_at, category = k.category, sentiment = k.sentiment,
         satisfaction = k.satisfaction, quality_score = k.quality_score, resolved = k.resolved,
         pending_on = k.pending_on, summary = k.summary, analysis = k.analysis, analysis_model = k.analysis_model,
         case_status = k.case_status, case_closed_by = k.case_closed_by, case_closed_at = k.case_closed_at,
         case_next_step = k.case_next_step, case_reason = k.case_reason, case_confidence = k.case_confidence,
         case_checked_at = k.case_checked_at, case_review = k.case_review
    from _ai_keep k
   where c.group_id = p_group and c.started_at = k.started_at;

  -- caso encerrado continua sem "aguardando resposta"
  update public.groups g set waiting_since = null, waiting_message_id = null
   where g.id = p_group and g.waiting_message_id is not null
     and exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                  where m.id = g.waiting_message_id and c.case_status = 'encerrado');
  return n;
end $$;
