-- Tela Helpdesk: acompanhamento do time interno (fora das métricas de atendimento).
-- "Entrada" = mensagem do helpdesk logo depois de alguém de fora do helpdesk (cliente ou time),
-- com até 24 h de intervalo; mede quanto o helpdesk demora para entrar na conversa e quem o acionou.
create or replace function public.dash_helpdesk(p_instance text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz text; v_prev_from timestamptz := p_from - (p_to - p_from); out jsonb;
begin
  perform public.require_user();
  select timezone into tz from public.app_settings where id = 1;

  with hd as (
    select m.id, m.group_id, m.conversation_id, m.attendant_id, m.sent_at, m.message_type, m.content,
           g.name as group_name, i.name as instance_name, i.color as instance_color,
           coalesce(a.name, m.sender_name, 'Helpdesk') as name,
           p.author_type as prev_author, p.sent_at as prev_at,
           coalesce(pa.name, case when p.author_type = 'supervisor' then 'Supervisor' end, p.sender_name, 'Cliente') as prev_name,
           left(coalesce(p.content, '[' || p.message_type || ']'), 240) as prev_text
      from public.messages m
      join public.groups g on g.id = m.group_id and g.monitored
      join public.instances i on i.id = m.instance_id
      left join public.attendants a on a.id = m.attendant_id
      left join lateral (select * from public.messages p where p.group_id = m.group_id and p.sent_at < m.sent_at
                          order by p.sent_at desc limit 1) p on true
      left join public.attendants pa on pa.id = p.attendant_id
     where m.author_type = 'helpdesk' and m.sent_at >= p_from and m.sent_at < p_to
       and public.inst_match(p_instance, i.slug)
  ), entries as (
    select *, extract(epoch from (sent_at - prev_at))::int as gap
      from hd where prev_author is not null and prev_author <> 'helpdesk' and sent_at - prev_at <= interval '24 hours'
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'msgs', (select count(*) from hd),
      'prev_msgs', (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                     join public.instances i on i.id = m.instance_id
                    where m.author_type = 'helpdesk' and m.sent_at >= v_prev_from and m.sent_at < p_from
                      and public.inst_match(p_instance, i.slug)),
      'groups', (select count(distinct group_id) from hd),
      'members_active', (select count(distinct attendant_id) from hd),
      'members_total', (select count(*) from public.attendants where team = 'helpdesk' and active),
      'entries', (select count(*) from entries),
      'median_entry_seconds', (select percentile_cont(0.5) within group (order by gap) from entries),
      'by_cliente', (select count(*) from entries where prev_author = 'cliente'),
      'by_time', (select count(*) from entries where prev_author in ('atendente', 'supervisor'))),
    'members', coalesce((select jsonb_agg(x order by x.msgs desc, x.name) from (
      select a.id, a.name, a.area, a.phone, a.active,
             (select count(*) from hd where hd.attendant_id = a.id) as msgs,
             (select count(distinct group_id) from hd where hd.attendant_id = a.id) as groups,
             (select count(*) from entries e where e.attendant_id = a.id) as entries,
             (select percentile_cont(0.5) within group (order by gap) from entries e where e.attendant_id = a.id) as median_entry_seconds,
             (select count(distinct (sent_at at time zone tz)::date) from hd where hd.attendant_id = a.id) as days_active,
             (select max(m.sent_at) from public.messages m where m.attendant_id = a.id) as last_at
        from public.attendants a where a.team = 'helpdesk' and (a.active or exists (select 1 from hd where hd.attendant_id = a.id))
    ) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d) from (
      select (sent_at at time zone tz)::date as d, count(*) as n from hd group by 1) t), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(x order by x.msgs desc) from (
      select group_id, group_name, instance_name, instance_color, count(*) as msgs, max(sent_at) as last_at,
             count(distinct attendant_id) as members
        from hd group by 1, 2, 3, 4 order by count(*) desc limit 12) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by x.sent_at desc) from (
      select id, group_id, conversation_id, group_name, instance_name, instance_color, name, sent_at,
             coalesce(content, '[' || message_type || ']') as text,
             prev_author, prev_name, prev_text,
             case when prev_author is not null and prev_author <> 'helpdesk' and sent_at - prev_at <= interval '24 hours'
                  then extract(epoch from (sent_at - prev_at))::int end as entry_seconds
        from hd order by sent_at desc limit 50) x), '[]'::jsonb)
  ) into out;
  return out;
end $$;
