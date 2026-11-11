-- Calibragem: nota de cada atendente em 8 critérios (7 avaliados pela IA + velocidade calculada).
alter table public.ai_batches drop constraint if exists ai_batches_kind_check;
alter table public.ai_batches add constraint ai_batches_kind_check check (kind in ('analise', 'casos', 'calibragem'));

create table if not exists public.calibrations (
  id           uuid primary key default gen_random_uuid(),
  attendant_id uuid not null references public.attendants(id) on delete cascade,
  created_at   timestamptz not null default now(),
  period_from  timestamptz not null,
  period_to    timestamptz not null,
  overall      numeric(4,1),
  scores       jsonb not null,   -- { criterio: { score, evidence, comment, improve, examples[] } }
  summary      text,
  strengths    text,
  improve      text,
  metrics      jsonb,
  model        text,
  batch_id     text
);
create index if not exists calibrations_att_idx on public.calibrations (attendant_id, created_at desc);
alter table public.calibrations enable row level security;

-- Mensagens e métricas de cada atendente no período (para a IA avaliar).
create or replace function public.ai_calibration_candidates(p_days int default 30, p_max_msgs int default 120, p_min_msgs int default 5)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_from timestamptz := now() - make_interval(days => p_days);
begin
  select * into s from public.app_settings where id = 1;
  return jsonb_build_object('from', v_from, 'to', now(), 'items', coalesce((select jsonb_agg(x) from (
    select a.id, a.name, a.area, a.products,
           (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
             where m.attendant_id = a.id and m.sent_at >= v_from) as msgs,
           (select jsonb_build_object(
                     'responses', count(*),
                     'median_seconds', percentile_cont(0.5) within group (order by eff_seconds),
                     'p90_seconds', percentile_cont(0.9) within group (order by eff_seconds),
                     'sla_pct', round(100.0 * avg(case when sla_breached then 0 else 1 end), 1),
                     'sla_minutes', s.default_sla_minutes)
              from public.v_responses r where r.attendant_id = a.id and r.responded_at >= v_from) as resp,
           -- iniciativas: mensagens que não vêm logo depois de um cliente (puxou/retomou a conversa)
           (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
             where m.attendant_id = a.id and m.sent_at >= v_from
               and not exists (select 1 from public.messages p where p.group_id = m.group_id and p.author_type = 'cliente'
                                 and p.sent_at < m.sent_at and p.sent_at > m.sent_at - interval '6 hours')
               and not exists (select 1 from public.messages p where p.group_id = m.group_id and p.attendant_id = a.id
                                 and p.sent_at < m.sent_at and p.sent_at > m.sent_at - interval '30 minutes')) as initiatives,
           (select count(distinct m.group_id) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
             where m.attendant_id = a.id and m.sent_at >= v_from) as groups,
           (select coalesce(jsonb_agg(z order by z.at), '[]'::jsonb) from (
              select m.sent_at as at, g.name as grp, coalesce(m.content, '[' || m.message_type || ']') as text,
                     (select jsonb_build_object('who', p.author_type, 'text', left(coalesce(p.content, '[' || p.message_type || ']'), 300))
                        from public.messages p where p.group_id = m.group_id and p.sent_at < m.sent_at
                       order by p.sent_at desc limit 1) as prev
                from public.messages m join public.groups g on g.id = m.group_id and g.monitored
               where m.attendant_id = a.id and m.sent_at >= v_from
               order by m.sent_at desc limit p_max_msgs) z) as messages
      from public.attendants a
     where a.active
  ) x where x.msgs >= p_min_msgs), '[]'::jsonb));
end $$;

create or replace function public.ai_save_calibrations(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.calibrations (attendant_id, period_from, period_to, overall, scores, summary, strengths, improve, metrics, model, batch_id)
  select (e ->> 'attendant_id')::uuid, (e ->> 'period_from')::timestamptz, (e ->> 'period_to')::timestamptz,
         (e ->> 'overall')::numeric, e -> 'scores', e ->> 'summary', e ->> 'strengths', e ->> 'improve',
         e -> 'metrics', e ->> 'model', e ->> 'batch_id'
    from jsonb_array_elements(p) e
   where exists (select 1 from public.attendants a where a.id = (e ->> 'attendant_id')::uuid);
  get diagnostics n = row_count;
  return n;
end $$;

-- Tela de calibragem: última nota de cada atendente + histórico.
create or replace function public.dash_calibration(p_instance text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x order by x.overall desc nulls last) from (
      select a.id as attendant_id, a.name, a.area, a.products, c.created_at, c.period_from, c.period_to,
             c.overall, c.scores, c.summary, c.strengths, c.improve, c.metrics,
             (select c2.overall from public.calibrations c2 where c2.attendant_id = a.id and c2.created_at < c.created_at
               order by c2.created_at desc limit 1) as prev_overall,
             (select jsonb_agg(jsonb_build_object('at', h.created_at, 'overall', h.overall) order by h.created_at)
                from (select created_at, overall from public.calibrations h where h.attendant_id = a.id
                       order by created_at desc limit 12) h) as history
        from public.attendants a
        join lateral (select * from public.calibrations c where c.attendant_id = a.id order by c.created_at desc limit 1) c on true
       where a.active and (coalesce(p_instance, '') in ('', 'all') or p_instance = any(a.products) or cardinality(a.products) = 0)
    ) x), '[]'::jsonb),
    'batch', (select jsonb_build_object('id', id, 'created_at', created_at, 'status', status, 'ended_at', ended_at,
                                        'count', cardinality(conversation_ids), 'result', result)
                from public.ai_batches where kind = 'calibragem' order by created_at desc limit 1));
end $$;
