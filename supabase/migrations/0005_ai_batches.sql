-- Análise por IA em lote (Message Batches): envio às 11h e às 16h, coleta dos resultados depois.

create table if not exists public.ai_batches (
  id               text primary key,               -- id do lote na Anthropic
  created_at       timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open', 'ended')),
  conversation_ids uuid[] not null default '{}',
  rosters          jsonb not null default '{}'::jsonb,  -- {conversation_id: [{code, attendant_id, name}]}
  ended_at         timestamptz,
  result           jsonb
);
alter table public.ai_batches enable row level security;

-- Pendentes: ignora o que já está num lote aberto. Limite maior (o lote aceita muitos pedidos).
create or replace function public.ai_pending_conversations(p_limit int default 20, p_idle_minutes int default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'categories', (select to_jsonb(categories) from public.app_settings where id = 1),
    'items', coalesce((select jsonb_agg(x) from (
      select c.id, c.started_at, c.last_message_at, g.name as group_name, i.name as instance_name,
             (select jsonb_agg(jsonb_build_object(
                        'at', mm.sent_at, 'author', mm.author_type, 'attendant_id', mm.attendant_id,
                        'name', coalesce(a.name, case when mm.author_type = 'supervisor' then 'Supervisor' end, mm.sender_name, 'Cliente'),
                        'type', mm.message_type, 'text', left(mm.content, 1200)) order by mm.sent_at)
                from (select * from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 80) mm
                left join public.attendants a on a.id = mm.attendant_id) as messages
        from public.conversations c
        join public.groups g on g.id = c.group_id and g.monitored
        join public.instances i on i.id = c.instance_id
       where c.customer_msgs > 0
         and c.last_message_at < now() - make_interval(mins => p_idle_minutes)
         and (c.analyzed_at is null or c.analyzed_at < c.last_message_at)
         and not exists (select 1 from public.ai_batches b where b.status = 'open' and c.id = any(b.conversation_ids))
       order by c.last_message_at desc
       limit greatest(1, least(p_limit, 2000))) x), '[]'::jsonb));
end $$;

create or replace function public.ai_batch_open()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'rosters', rosters) order by created_at), '[]'::jsonb)
    from public.ai_batches where status = 'open';
$$;

create or replace function public.ai_batch_create(p_id text, p_rosters jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_batches (id, conversation_ids, rosters)
  values (p_id, array(select k::uuid from jsonb_object_keys(p_rosters) k), p_rosters);
end $$;

-- Salva várias análises de uma vez: p = [{id, analysis, model}]
create or replace function public.ai_save_analyses(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  for r in select * from jsonb_array_elements(p) loop
    perform public.ai_save_analysis((r ->> 'id')::uuid, r -> 'analysis', r ->> 'model');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Fecha o lote. analyzed_at volta para a hora do envio: mensagens que chegaram depois
-- fazem o atendimento ser analisado de novo no próximo lote.
create or replace function public.ai_batch_close(p_id text, p_result jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare b public.ai_batches;
begin
  update public.ai_batches set status = 'ended', ended_at = now(), result = p_result
   where id = p_id and status = 'open' returning * into b;
  if b.id is null then return; end if;
  update public.conversations set analyzed_at = b.created_at
   where id = any(b.conversation_ids) and analyzed_at > b.created_at;
end $$;

-- Painel: último lote (para mostrar quando rodou).
create or replace function public.ai_batch_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return (select jsonb_build_object('id', id, 'created_at', created_at, 'status', status, 'ended_at', ended_at,
                                    'count', cardinality(conversation_ids), 'result', result)
            from public.ai_batches order by created_at desc limit 1);
end $$;

