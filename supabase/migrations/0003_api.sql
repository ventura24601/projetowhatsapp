-- =====================================================================
-- API do painel (RPCs). Todas exigem login; as de escrita exigem admin.
-- =====================================================================

create or replace view public.v_responses with (security_invoker = true) as
select r.*,
       i.slug  as instance_slug,
       i.name  as instance_name,
       g.name  as group_name,
       case when s.use_business_hours then r.business_seconds else r.response_seconds end as eff_seconds
  from public.response_events r
  join public.instances i on i.id = r.instance_id
  join public.groups g    on g.id = r.group_id and g.monitored
 cross join public.app_settings s;

create or replace function public.inst_match(p_instance text, p_slug text)
returns boolean language sql immutable as $$
  select coalesce(p_instance, '') in ('', 'all') or p_instance = p_slug
$$;

-- ---------- KPIs de resposta de um período ----------
create or replace function public.resp_kpis(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'responses',        count(*),
    'median_seconds',   percentile_cont(0.5) within group (order by eff_seconds),
    'p90_seconds',      percentile_cont(0.9) within group (order by eff_seconds),
    'avg_seconds',      avg(eff_seconds),
    'first_median',     percentile_cont(0.5) within group (order by eff_seconds) filter (where is_first_response),
    'sla_pct',          round(100.0 * avg(case when sla_breached then 0 else 1 end), 1),
    'breached',         count(*) filter (where sla_breached)
  )
  from public.v_responses
  where responded_at >= p_from and responded_at < p_to
    and public.inst_match(p_instance, instance_slug)
$$;

-- ---------- Visão geral ----------
create or replace function public.dash_overview(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s public.app_settings;
  v_len interval := p_to - p_from;
  out jsonb;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;

  with msgs as (
    select m.*, i.slug
      from public.messages m
      join public.instances i on i.id = m.instance_id
      join public.groups g    on g.id = m.group_id and g.monitored
     where m.sent_at >= p_from and m.sent_at < p_to
       and public.inst_match(p_instance, i.slug)
  ), resp as (
    select * from public.v_responses
     where responded_at >= p_from and responded_at < p_to
       and public.inst_match(p_instance, instance_slug)
  ), waiting as (
    select g.id,
           public.effective_seconds(g.waiting_since, now()) as eff,
           coalesce(g.sla_minutes, s.default_sla_minutes) as sla
      from public.groups g join public.instances i on i.id = g.instance_id
     where g.monitored and g.waiting_since is not null
       and public.inst_match(p_instance, i.slug)
  )
  select jsonb_build_object(
    'kpis', public.resp_kpis(p_instance, p_from, p_to) || jsonb_build_object(
        'customer_msgs', (select count(*) from msgs where author_type = 'cliente'),
        'team_msgs',     (select count(*) from msgs where author_type <> 'cliente'),
        'active_groups', (select count(distinct group_id) from msgs),
        'conversations', (select count(*) from public.conversations c
                            join public.instances i on i.id = c.instance_id
                            join public.groups g on g.id = c.group_id and g.monitored
                           where c.started_at >= p_from and c.started_at < p_to
                             and public.inst_match(p_instance, i.slug)),
        'waiting_now',      (select count(*) from waiting),
        'waiting_breached', (select count(*) from waiting where eff > sla * 60)
    ),
    'prev', public.resp_kpis(p_instance, p_from - v_len, p_from),
    'by_day', coalesce((
      select jsonb_agg(d order by d.day) from (
        select (responded_at at time zone s.timezone)::date as day,
               count(*) as responses,
               percentile_cont(0.5) within group (order by eff_seconds) as median_seconds,
               round(100.0 * avg(case when sla_breached then 0 else 1 end), 1) as sla_pct
          from resp group by 1
      ) d), '[]'::jsonb),
    'buckets', (
      select jsonb_agg(jsonb_build_object('label', b.label, 'n', coalesce(x.n, 0)) order by b.ord)
        from (values (1, 'até 5 min', 0, 300), (2, '5–15 min', 300, 900), (3, '15–30 min', 900, 1800),
                     (4, '30–60 min', 1800, 3600), (5, '1–2 h', 3600, 7200), (6, '2–4 h', 7200, 14400),
                     (7, 'mais de 4 h', 14400, 2147483647)) as b(ord, label, lo, hi)
        left join lateral (select count(*) as n from resp where eff_seconds >= b.lo and eff_seconds < b.hi) x on true),
    'by_instance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', i.slug, 'name', i.name, 'color', i.color,
               'last_event_at', i.last_event_at,
               'kpis', public.resp_kpis(i.slug, p_from, p_to),
               'customer_msgs', (select count(*) from msgs where msgs.slug = i.slug and author_type = 'cliente'),
               'waiting_now', (select count(*) from public.groups g where g.instance_id = i.id and g.monitored and g.waiting_since is not null)
             ) order by i.created_at)
        from public.instances i where public.inst_match(p_instance, i.slug)), '[]'::jsonb),
    'heat', coalesce((
      select jsonb_agg(h) from (
        select extract(isodow from sent_at at time zone s.timezone)::int as dow,
               extract(hour   from sent_at at time zone s.timezone)::int as hour,
               count(*) as n
          from msgs where author_type = 'cliente' group by 1, 2
      ) h), '[]'::jsonb),
    'worst_groups', coalesce((
      select jsonb_agg(w) from (
        select group_id, group_name, instance_name,
               count(*) as responses,
               count(*) filter (where sla_breached) as breached,
               percentile_cont(0.5) within group (order by eff_seconds) as median_seconds
          from resp group by 1, 2, 3
         having count(*) filter (where sla_breached) > 0
         order by count(*) filter (where sla_breached) desc, 6 desc
         limit 8
      ) w), '[]'::jsonb),
    'business_hours', jsonb_build_object('enabled', s.use_business_hours, 'start', s.business_start,
                                         'end', s.business_end, 'days', s.business_days, 'timezone', s.timezone)
  ) into out;
  return out;
end $$;

-- ---------- Pendências: grupos com cliente aguardando agora ----------
create or replace function public.dash_pending(p_instance text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; out jsonb;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;
  select coalesce(jsonb_agg(x order by x.eff_seconds desc), '[]'::jsonb) into out from (
    select g.id as group_id, g.name as group_name,
           i.slug as instance_slug, i.name as instance_name, i.color as instance_color,
           g.waiting_since,
           extract(epoch from now() - g.waiting_since)::int as wall_seconds,
           public.effective_seconds(g.waiting_since, now())  as eff_seconds,
           coalesce(g.sla_minutes, s.default_sla_minutes)   as sla_minutes,
           public.effective_seconds(g.waiting_since, now()) > coalesce(g.sla_minutes, s.default_sla_minutes) * 60 as breached,
           wm.content as first_message, wm.sender_name as customer_name,
           (select count(*) from public.messages m2
             where m2.group_id = g.id and m2.author_type = 'cliente' and m2.sent_at >= g.waiting_since) as unanswered_msgs,
           (select m3.content from public.messages m3
             where m3.group_id = g.id and m3.author_type = 'cliente'
             order by m3.sent_at desc limit 1) as last_message,
           oa.name as owner_name,
           (select coalesce(a.name, case when r.author_type = 'supervisor' then 'Supervisor' end)
              from public.response_events r left join public.attendants a on a.id = r.attendant_id
             where r.group_id = g.id order by r.responded_at desc limit 1) as last_responder
      from public.groups g
      join public.instances i on i.id = g.instance_id
      left join public.messages wm on wm.id = g.waiting_message_id
      left join public.attendants oa on oa.id = g.owner_attendant_id
     where g.monitored and g.waiting_since is not null
       and public.inst_match(p_instance, i.slug)
  ) x;
  return out;
end $$;

-- ---------- Equipe ----------
create or replace function public.dash_team(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  perform public.require_user();
  with resp as (
    select * from public.v_responses
     where responded_at >= p_from and responded_at < p_to and public.inst_match(p_instance, instance_slug)
  ), sent as (
    select m.attendant_id, m.author_type, m.instance_id, count(*) as msgs, count(distinct m.group_id) as groups,
           max(m.sent_at) as last_at
      from public.messages m
      join public.instances i on i.id = m.instance_id
      join public.groups g on g.id = m.group_id and g.monitored
     where m.sent_at >= p_from and m.sent_at < p_to and m.author_type <> 'cliente'
       and public.inst_match(p_instance, i.slug)
     group by 1, 2, 3
  ), fb as (
    select (f ->> 'attendant_id')::uuid as attendant_id,
           avg((f ->> 'score')::numeric) as quality, count(*) as evaluated
      from public.conversations c
      join public.instances i on i.id = c.instance_id
      cross join lateral jsonb_array_elements(coalesce(c.analysis -> 'team_feedback', '[]'::jsonb)) f
     where c.started_at >= p_from and c.started_at < p_to and public.inst_match(p_instance, i.slug)
       and (f ->> 'attendant_id') is not null and (f ->> 'score') ~ '^[0-9.]+$'
     group by 1
  ), people as (
    select a.id, a.name, a.area, a.phone, a.active, false as is_supervisor, null::text as instance_name
      from public.attendants a
    union all
    select null, 'Supervisor · ' || i.name, 'supervisão', i.connected_phone, true, true, i.name
      from public.instances i where public.inst_match(p_instance, i.slug)
  )
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.responses desc nulls last, t.msgs desc nulls last, t.name), '[]'::jsonb)
    into out
    from (
      select p.id, p.name, p.area, p.phone, p.active, p.is_supervisor,
             coalesce((select sum(msgs) from sent where (p.is_supervisor and sent.author_type = 'supervisor'
                         and sent.instance_id = (select id from public.instances where name = p.instance_name))
                         or (not p.is_supervisor and sent.attendant_id = p.id)), 0) as msgs,
             (select count(distinct m.group_id) from public.messages m
                join public.instances i on i.id = m.instance_id
               where m.sent_at >= p_from and m.sent_at < p_to and public.inst_match(p_instance, i.slug)
                 and ((p.is_supervisor and m.author_type = 'supervisor' and i.name = p.instance_name)
                   or (not p.is_supervisor and m.attendant_id = p.id))) as groups,
             r.responses, r.median_seconds, r.avg_seconds, r.sla_pct, r.first_responses,
             (select max(last_at) from sent where (not p.is_supervisor and sent.attendant_id = p.id)
                or (p.is_supervisor and sent.author_type = 'supervisor'
                    and sent.instance_id = (select id from public.instances where name = p.instance_name))) as last_at,
             round(fb.quality, 1) as quality, fb.evaluated
        from people p
        left join lateral (
          select count(*) as responses,
                 percentile_cont(0.5) within group (order by eff_seconds) as median_seconds,
                 avg(eff_seconds) as avg_seconds,
                 round(100.0 * avg(case when sla_breached then 0 else 1 end), 1) as sla_pct,
                 count(*) filter (where is_first_response) as first_responses
            from resp
           where (not p.is_supervisor and resp.attendant_id = p.id)
              or (p.is_supervisor and resp.author_type = 'supervisor' and resp.instance_name = p.instance_name)
        ) r on true
        left join fb on fb.attendant_id = p.id
       where p.active or r.responses > 0
    ) t;
  return out;
end $$;

-- ---------- Grupos ----------
create or replace function public.dash_groups(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; out jsonb;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.monitored desc, t.last_message_at desc nulls last), '[]'::jsonb)
    into out from (
      select g.id, g.name, g.wa_id, g.monitored, g.notes, g.sla_minutes,
             coalesce(g.sla_minutes, s.default_sla_minutes) as effective_sla,
             g.owner_attendant_id, oa.name as owner_name,
             i.slug as instance_slug, i.name as instance_name, i.color as instance_color,
             g.last_message_at, g.waiting_since,
             case when g.waiting_since is not null then public.effective_seconds(g.waiting_since, now()) end as waiting_eff,
             mm.customer_msgs, mm.team_msgs,
             rr.responses, rr.median_seconds, rr.sla_pct, rr.breached,
             (select c.sentiment from public.conversations c
               where c.group_id = g.id and c.sentiment is not null order by c.started_at desc limit 1) as last_sentiment
        from public.groups g
        join public.instances i on i.id = g.instance_id
        left join public.attendants oa on oa.id = g.owner_attendant_id
        left join lateral (
          select count(*) filter (where author_type = 'cliente') as customer_msgs,
                 count(*) filter (where author_type <> 'cliente') as team_msgs
            from public.messages m where m.group_id = g.id and m.sent_at >= p_from and m.sent_at < p_to) mm on true
        left join lateral (
          select count(*) as responses,
                 percentile_cont(0.5) within group (order by case when s.use_business_hours then r.business_seconds else r.response_seconds end) as median_seconds,
                 round(100.0 * avg(case when r.sla_breached then 0 else 1 end), 1) as sla_pct,
                 count(*) filter (where r.sla_breached) as breached
            from public.response_events r where r.group_id = g.id and r.responded_at >= p_from and r.responded_at < p_to) rr on true
       where public.inst_match(p_instance, i.slug)
    ) t;
  return out;
end $$;

-- ---------- Atendimentos (conversas) ----------
create or replace function public.list_conversations(
  p_instance text, p_from timestamptz, p_to timestamptz,
  p_group uuid default null, p_category text default null, p_status text default null,
  p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  perform public.require_user();
  with base as (
    select c.*, g.name as group_name, i.slug as instance_slug, i.name as instance_name, i.color as instance_color
      from public.conversations c
      join public.groups g on g.id = c.group_id and g.monitored
      join public.instances i on i.id = c.instance_id
     where c.last_message_at >= p_from and c.started_at < p_to
       and public.inst_match(p_instance, i.slug)
       and (p_group is null or c.group_id = p_group)
       and (coalesce(p_category, '') = '' or c.category = p_category)
       and (coalesce(p_status, '') = ''
            or (p_status = 'aguardando_equipe' and c.status = 'aguardando_equipe')
            or (p_status = 'nao_resolvido' and c.resolved = false)
            or (p_status = 'negativo' and c.sentiment in ('negativo', 'irritado'))
            or (p_status = 'sem_analise' and c.analyzed_at is null))
       and (coalesce(p_search, '') = '' or g.name ilike '%' || p_search || '%'
            or c.summary ilike '%' || p_search || '%'
            or exists (select 1 from public.messages m where m.conversation_id = c.id and m.content ilike '%' || p_search || '%'))
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'items', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb order by x.last_message_at desc) from (
        select b.id, b.group_id, b.group_name, b.instance_slug, b.instance_name, b.instance_color,
               b.started_at, b.last_message_at, b.first_response_seconds, b.customer_msgs, b.team_msgs, b.status,
               b.category, b.sentiment, b.satisfaction, b.quality_score, b.resolved, b.pending_on, b.summary,
               b.analyzed_at,
               (select array_agg(distinct coalesce(a.name, 'Supervisor'))
                  from public.messages m left join public.attendants a on a.id = m.attendant_id
                 where m.conversation_id = b.id and m.author_type <> 'cliente') as team
          from base b order by b.last_message_at desc
          limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)
      ) x), '[]'::jsonb)
  ) into out;
  return out;
end $$;

create or replace function public.get_messages(p_conversation uuid default null, p_group uuid default null, p_limit int default 300)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb; v_conv jsonb;
begin
  perform public.require_user();
  if p_conversation is not null then
    select row_to_json(c)::jsonb || jsonb_build_object('group_name', g.name, 'instance_name', i.name)
      into v_conv
      from public.conversations c join public.groups g on g.id = c.group_id join public.instances i on i.id = c.instance_id
     where c.id = p_conversation;
  end if;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sent_at), '[]'::jsonb) into out from (
    select m.id, m.sent_at, m.author_type, m.sender_name, m.sender_phone, m.message_type, m.content,
           m.opens_wait, m.conversation_id, a.name as attendant_name,
           r.eff_seconds as response_seconds, r.sla_breached
      from public.messages m
      left join public.attendants a on a.id = m.attendant_id
      left join public.v_responses r on r.team_message_id = m.id
     where (p_conversation is not null and m.conversation_id = p_conversation)
        or (p_conversation is null and m.group_id = p_group)
     order by m.sent_at desc
     limit greatest(1, least(p_limit, 1000))
  ) x;
  return jsonb_build_object('conversation', v_conv, 'messages', out);
end $$;

-- ---------- Análise (IA) ----------
create or replace function public.dash_insights(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  perform public.require_user();
  with c as (
    select c.*, g.name as group_name, i.name as instance_name, i.slug as instance_slug
      from public.conversations c
      join public.groups g on g.id = c.group_id and g.monitored
      join public.instances i on i.id = c.instance_id
     where c.started_at >= p_from and c.started_at < p_to and c.customer_msgs > 0
       and public.inst_match(p_instance, i.slug)
  ), a as (select * from c where analyzed_at is not null)
  select jsonb_build_object(
    'total',        (select count(*) from c),
    'analyzed',     (select count(*) from a),
    'resolved_pct', (select round(100.0 * avg(case when resolved then 1 else 0 end), 1) from a where resolved is not null),
    'avg_quality',  (select round(avg(quality_score), 1) from a),
    'avg_satisfaction', (select round(avg(satisfaction), 2) from a),
    'categories',   coalesce((select jsonb_agg(x order by x.n desc) from (
                       select category, count(*) as n,
                              count(*) filter (where instance_slug = 'black') as black,
                              count(*) filter (where instance_slug = 'redes') as redes
                         from a where category is not null group by 1) x), '[]'::jsonb),
    'sentiments',   coalesce((select jsonb_object_agg(sentiment, n) from (
                       select sentiment, count(*) as n from a where sentiment is not null group by 1) x), '{}'::jsonb),
    'pending_on',   coalesce((select jsonb_object_agg(pending_on, n) from (
                       select pending_on, count(*) as n from a where pending_on is not null group by 1) x), '{}'::jsonb),
    'holding_replies', (select count(*) from a where (analysis ->> 'holding_reply_without_followup')::boolean),
    'topics',       coalesce((select jsonb_agg(x order by x.n desc) from (
                       select lower(t) as topic, count(*) as n
                         from a, jsonb_array_elements_text(coalesce(analysis -> 'topics', '[]'::jsonb)) t
                        group by 1 order by 2 desc limit 20) x), '[]'::jsonb),
    'questions',    coalesce((select jsonb_agg(x) from (
                       select q as question, group_name, instance_name, id as conversation_id, started_at
                         from a, jsonb_array_elements_text(coalesce(analysis -> 'customer_questions', '[]'::jsonb)) q
                        order by started_at desc limit 40) x), '[]'::jsonb),
    'issues',       coalesce((select jsonb_agg(x) from (
                       select i as issue, group_name, instance_name, id as conversation_id, started_at
                         from a, jsonb_array_elements_text(coalesce(analysis -> 'issues', '[]'::jsonb)) i
                        order by started_at desc limit 40) x), '[]'::jsonb),
    'attention',    coalesce((select jsonb_agg(x) from (
                       select id as conversation_id, group_name, instance_name, started_at, category, sentiment,
                              summary, resolved, pending_on
                         from a
                        where sentiment in ('negativo', 'irritado') or resolved = false
                        order by (sentiment = 'irritado') desc, started_at desc limit 25) x), '[]'::jsonb),
    'team_feedback', coalesce((select jsonb_agg(x order by x.score desc nulls last) from (
                       select f ->> 'attendant_id' as attendant_id,
                              max(f ->> 'name') as name,
                              round(avg((f ->> 'score')::numeric), 1) as score,
                              count(*) as n,
                              (array_agg(f ->> 'strengths' order by started_at desc))[1:3] as strengths,
                              (array_agg(f ->> 'improve'   order by started_at desc))[1:3] as improve
                         from a, jsonb_array_elements(coalesce(analysis -> 'team_feedback', '[]'::jsonb)) f
                        where (f ->> 'score') ~ '^[0-9.]+$'
                        group by 1) x), '[]'::jsonb)
  ) into out;
  return out;
end $$;

-- =====================================================================
-- Cadastros (admin)
-- =====================================================================

create or replace function public.list_instances()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean;
begin
  perform public.require_user();
  v_admin := public.current_role_name() = 'admin';
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'slug', i.slug, 'name', i.name, 'color', i.color, 'connected_phone', i.connected_phone,
      'supervisor_is_team', i.supervisor_is_team, 'active', i.active, 'last_event_at', i.last_event_at,
      'webhook_secret', case when v_admin then i.webhook_secret end,
      'groups', (select count(*) from public.groups g where g.instance_id = i.id),
      'messages_24h', (select count(*) from public.messages m where m.instance_id = i.id and m.sent_at > now() - interval '24 hours')
    ) order by i.created_at) from public.instances i), '[]'::jsonb);
end $$;

create or replace function public.save_instance(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_admin();
  if v_id is null then
    insert into public.instances (slug, name, color)
    values (lower(p ->> 'slug'), p ->> 'name', coalesce(nullif(p ->> 'color', ''), '#3b82f6'))
    returning id into v_id;
  end if;
  update public.instances set
    name               = coalesce(nullif(p ->> 'name', ''), name),
    color              = coalesce(nullif(p ->> 'color', ''), color),
    active             = coalesce((p ->> 'active')::boolean, active),
    supervisor_is_team = coalesce((p ->> 'supervisor_is_team')::boolean, supervisor_is_team),
    connected_phone    = coalesce(nullif(p ->> 'connected_phone', ''), connected_phone),
    webhook_secret     = case when coalesce((p ->> 'regenerate_secret')::boolean, false)
                              then replace(gen_random_uuid()::text, '-', '') else webhook_secret end
  where id = v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.list_attendants()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.name) from (
    select a.id, a.name, a.phone, a.lid, a.area, a.products, a.active, a.created_at,
           (select count(*) from public.messages m where m.attendant_id = a.id and m.sent_at > now() - interval '30 days') as msgs_30d,
           (select max(m.sent_at) from public.messages m where m.attendant_id = a.id) as last_seen
      from public.attendants a) t), '[]'::jsonb);
end $$;

-- Grupos que precisam ser reprocessados quando um telefone muda de "cliente" para "time" (ou o contrário)
create or replace function public.groups_with_sender(p_phone_key text, p_lid text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct group_id), '{}') from public.messages
   where (p_phone_key is not null and public.phone_key(sender_phone) = p_phone_key)
      or (coalesce(p_lid, '') <> '' and sender_lid = p_lid)
$$;

create or replace function public.save_attendant(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
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
    raise exception 'Já existe um atendente com esse telefone.';
  end if;

  if v_id is null then
    insert into public.attendants (name, phone, lid, area, products, active)
    values (p ->> 'name', p ->> 'phone', nullif(p ->> 'lid', ''), nullif(p ->> 'area', ''),
            coalesce(array(select jsonb_array_elements_text(p -> 'products')), '{}'),
            coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.attendants set
      name = p ->> 'name', phone = p ->> 'phone', lid = nullif(p ->> 'lid', ''), area = nullif(p ->> 'area', ''),
      products = coalesce(array(select jsonb_array_elements_text(p -> 'products')), '{}'),
      active = coalesce((p ->> 'active')::boolean, true)
    where id = v_id;
  end if;

  v_groups := public.groups_with_sender(public.phone_key(p ->> 'phone'), nullif(p ->> 'lid', ''));
  if old.id is not null and (old.phone_key is distinct from public.phone_key(p ->> 'phone') or old.lid is distinct from nullif(p ->> 'lid', '')) then
    v_groups := v_groups || public.groups_with_sender(old.phone_key, old.lid);
  end if;
  return jsonb_build_object('id', v_id, 'affected_groups', to_jsonb(array(select distinct unnest(v_groups))));
end $$;

create or replace function public.delete_attendant(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare old public.attendants; v_groups uuid[];
begin
  perform public.require_admin();
  select * into old from public.attendants where id = p_id;
  if old.id is null then return jsonb_build_object('affected_groups', '[]'::jsonb); end if;
  v_groups := public.groups_with_sender(old.phone_key, old.lid);
  delete from public.attendants where id = p_id;
  return jsonb_build_object('affected_groups', to_jsonb(v_groups));
end $$;

create or replace function public.admin_rebuild_group(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  return public.rebuild_group(p_group);
end $$;

create or replace function public.admin_all_group_ids()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return coalesce((select jsonb_agg(id) from public.groups), '[]'::jsonb);
end $$;

-- Números que aparecem em vários grupos e ainda não estão cadastrados (provável time)
create or replace function public.unknown_senders(p_instance text default null, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.groups desc, t.msgs desc) from (
    select public.phone_key(m.sender_phone) as key,
           (array_agg(m.sender_phone order by m.sent_at desc))[1] as phone,
           (array_agg(m.sender_name order by m.sent_at desc) filter (where m.sender_name is not null))[1] as name,
           (array_agg(m.sender_lid order by m.sent_at desc) filter (where m.sender_lid is not null))[1] as lid,
           count(*) as msgs, count(distinct m.group_id) as groups,
           array_agg(distinct i.name) as instances,
           max(m.sent_at) as last_seen
      from public.messages m join public.instances i on i.id = m.instance_id
     where m.author_type = 'cliente' and coalesce(m.sender_phone, '') <> ''
       and m.sent_at > now() - make_interval(days => p_days)
       and public.inst_match(p_instance, i.slug)
     group by 1
     order by count(distinct m.group_id) desc, count(*) desc
     limit 60) t), '[]'::jsonb);
end $$;

create or replace function public.save_group(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p ->> 'id')::uuid; s public.app_settings;
begin
  perform public.require_admin();
  select * into s from public.app_settings where id = 1;
  update public.groups set
    sla_minutes        = case when p ? 'sla_minutes' then nullif(p ->> 'sla_minutes', '')::int else sla_minutes end,
    owner_attendant_id = case when p ? 'owner_attendant_id' then nullif(p ->> 'owner_attendant_id', '')::uuid else owner_attendant_id end,
    monitored          = coalesce((p ->> 'monitored')::boolean, monitored),
    notes              = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
    name               = coalesce(nullif(p ->> 'name', ''), name)
  where id = v_id;
  update public.response_events r
     set sla_minutes  = coalesce(g.sla_minutes, s.default_sla_minutes),
         sla_breached = (case when s.use_business_hours then r.business_seconds else r.response_seconds end)
                        > coalesce(g.sla_minutes, s.default_sla_minutes) * 60
    from public.groups g where g.id = r.group_id and r.group_id = v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.resolve_waiting(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.conversations set status = 'aguardando_cliente'
   where id = (select conversation_id from public.messages
                where id = (select waiting_message_id from public.groups where id = p_group));
  update public.groups set waiting_since = null, waiting_message_id = null where id = p_group;
end $$;

create or replace function public.get_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return (select row_to_json(s)::jsonb from public.app_settings s where id = 1);
end $$;

create or replace function public.save_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.app_settings set
    timezone                 = coalesce(nullif(p ->> 'timezone', ''), timezone),
    business_days            = coalesce(array(select jsonb_array_elements_text(p -> 'business_days')::int), business_days),
    business_start           = coalesce(nullif(p ->> 'business_start', '')::time, business_start),
    business_end             = coalesce(nullif(p ->> 'business_end', '')::time, business_end),
    holidays                 = case when p ? 'holidays' then array(select jsonb_array_elements_text(p -> 'holidays')::date) else holidays end,
    use_business_hours       = coalesce((p ->> 'use_business_hours')::boolean, use_business_hours),
    default_sla_minutes      = coalesce(nullif(p ->> 'default_sla_minutes', '')::int, default_sla_minutes),
    conversation_gap_minutes = coalesce(nullif(p ->> 'conversation_gap_minutes', '')::int, conversation_gap_minutes),
    categories               = case when p ? 'categories' then array(select jsonb_array_elements_text(p -> 'categories')) else categories end,
    updated_at               = now()
  where id = 1;
  perform public.recompute_sla(now() - interval '120 days');
  return public.get_settings();
end $$;

-- Recalcula horário comercial e SLA dos eventos (após mudar expediente/SLA padrão)
create or replace function public.recompute_sla(p_from timestamptz)
returns int language plpgsql security definer set search_path = public as $$
declare s public.app_settings; n int;
begin
  select * into s from public.app_settings where id = 1;
  update public.response_events r
     set business_seconds = public.business_seconds(r.waited_from, r.responded_at),
         sla_minutes      = coalesce(g.sla_minutes, s.default_sla_minutes)
    from public.groups g
   where g.id = r.group_id and r.responded_at >= p_from;
  update public.response_events r
     set sla_breached = (case when s.use_business_hours then r.business_seconds else r.response_seconds end) > r.sla_minutes * 60
   where r.responded_at >= p_from;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.list_users()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return coalesce((select jsonb_agg(row_to_json(u)::jsonb order by u.created_at) from public.user_roles u), '[]'::jsonb);
end $$;

create or replace function public.set_user_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_user = auth.uid() and p_role <> 'admin' then
    raise exception 'Você não pode remover seu próprio acesso de admin.';
  end if;
  if p_role = 'remove' then
    delete from public.user_roles where user_id = p_user;
  else
    update public.user_roles set role = p_role where user_id = p_user;
  end if;
end $$;

-- =====================================================================
-- Análise por IA (chamadas pela Netlify Function com service role)
-- =====================================================================

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
       order by c.last_message_at desc
       limit greatest(1, least(p_limit, 100))) x), '[]'::jsonb));
end $$;

create or replace function public.ai_save_analysis(p_conversation uuid, p jsonb, p_model text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    analyzed_at    = now(),
    category       = p ->> 'category',
    sentiment      = p ->> 'sentiment',
    satisfaction   = nullif(p ->> 'satisfaction', '')::int,
    quality_score  = nullif(p ->> 'quality_score', '')::numeric,
    resolved       = (p ->> 'resolved')::boolean,
    pending_on     = p ->> 'pending_on',
    summary        = p ->> 'summary',
    analysis       = p,
    analysis_model = p_model
  where id = p_conversation;
end $$;
