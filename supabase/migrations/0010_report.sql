-- Relatório para gestores (11h e 15h): números do período e o que precisa de atenção.

create table if not exists public.report_log (
  id          bigserial primary key,
  kind        text not null,
  sent_at     timestamptz not null default now(),
  period_from timestamptz,
  period_to   timestamptz,
  test        boolean not null default false,
  http_status int,
  error       text
);
alter table public.report_log enable row level security;

create or replace function public.mgr_report(p_since timestamptz, p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings;
begin
  select * into s from public.app_settings where id = 1;
  return jsonb_build_object(
    'by_instance', coalesce((select jsonb_agg(jsonb_build_object(
        'slug', i.slug, 'name', i.name,
        'kpis', public.resp_kpis(i.slug, p_since, p_until),
        'customer_msgs', (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                           where m.instance_id = i.id and m.author_type = 'cliente' and m.sent_at >= p_since and m.sent_at < p_until),
        'team_msgs', (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                       where m.instance_id = i.id and m.author_type <> 'cliente' and m.sent_at >= p_since and m.sent_at < p_until),
        'active_groups', (select count(distinct m.group_id) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                           where m.instance_id = i.id and m.sent_at >= p_since and m.sent_at < p_until),
        'closed', coalesce((select jsonb_object_agg(case_closed_by, n) from (
                     select c.case_closed_by, count(*) n from public.conversations c
                      where c.instance_id = i.id and c.case_status = 'encerrado'
                        and c.case_closed_at >= p_since and c.case_closed_at < p_until group by 1) x), '{}'::jsonb),
        'negative', (select count(*) from public.conversations c
                      where c.instance_id = i.id and c.sentiment in ('negativo', 'irritado')
                        and c.last_message_at >= p_since and c.last_message_at < p_until)
      ) order by i.slug) from public.instances i), '[]'::jsonb),

    -- grupos esperando resposta agora (mais urgentes primeiro)
    'waiting', coalesce((select jsonb_agg(x order by x.breached desc, x.eff_seconds desc) from (
        select g.name as group_name, i.name as instance_name, g.waiting_since,
               public.effective_seconds(g.waiting_since, now()) as eff_seconds,
               coalesce(g.sla_minutes, s.default_sla_minutes) as sla_minutes,
               public.effective_seconds(g.waiting_since, now()) > coalesce(g.sla_minutes, s.default_sla_minutes) * 60 as breached,
               left(wm.content, 160) as first_message, wm.sender_name as customer_name,
               oa.name as owner_name, c.case_reason as reason,
               (select count(*) from public.messages m2 where m2.group_id = g.id and m2.author_type = 'cliente'
                  and m2.sent_at >= g.waiting_since) as unanswered
          from public.groups g
          join public.instances i on i.id = g.instance_id
          left join public.messages wm on wm.id = g.waiting_message_id
          left join public.conversations c on c.id = wm.conversation_id
          left join public.attendants oa on oa.id = g.owner_attendant_id
         where g.monitored and g.waiting_since is not null) x), '[]'::jsonb),

    -- casos abertos em que o time precisa agir (últimos 7 dias)
    'open_cases', coalesce((select jsonb_agg(x order by x.urgency desc, x.last_message_at) from (
        select c.id, g.name as group_name, i.name as instance_name, c.last_message_at, c.case_reason as reason,
               c.case_confidence as confidence, c.sentiment, c.summary,
               c.last_message_at >= p_since as new_in_period,
               exists (select 1 from public.messages wm where wm.id = g.waiting_message_id and wm.conversation_id = c.id) as waiting,
               coalesce((c.analysis ->> 'holding_reply_without_followup')::boolean, false) as holding,
               (case when c.sentiment in ('negativo', 'irritado') then 3 else 0 end
                + case when coalesce((c.analysis ->> 'holding_reply_without_followup')::boolean, false) then 2 else 0 end
                + case when exists (select 1 from public.messages wm where wm.id = g.waiting_message_id and wm.conversation_id = c.id) then 1 else 0 end
                + case when c.last_message_at < now() - interval '24 hours' then 1 else 0 end) as urgency
          from public.conversations c
          join public.groups g on g.id = c.group_id and g.monitored
          join public.instances i on i.id = c.instance_id
         where c.case_status = 'aberto' and c.customer_msgs > 0
           and coalesce(c.case_next_step, 'equipe') <> 'cliente'
           and c.last_message_at > now() - interval '7 days') x), '[]'::jsonb),

    -- clientes insatisfeitos no período
    'negative', coalesce((select jsonb_agg(x order by x.last_message_at desc) from (
        select g.name as group_name, i.name as instance_name, c.sentiment, c.summary, c.last_message_at, c.case_status
          from public.conversations c
          join public.groups g on g.id = c.group_id and g.monitored
          join public.instances i on i.id = c.instance_id
         where c.sentiment in ('negativo', 'irritado') and c.last_message_at >= p_since and c.last_message_at < p_until) x), '[]'::jsonb)
  );
end $$;

create or replace function public.report_log_add(p_kind text, p_from timestamptz, p_to timestamptz, p_test boolean,
                                                 p_status int, p_error text)
returns void language sql security definer set search_path = public as $$
  insert into public.report_log (kind, period_from, period_to, test, http_status, error)
  values (p_kind, p_from, p_to, p_test, p_status, p_error);
$$;
