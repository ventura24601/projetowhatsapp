-- Quadro comparativo entre os números monitorados (Black x Redes) na visão geral.
create or replace function public.dash_compare(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; v_len interval := p_to - p_from;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'slug', i.slug, 'name', i.name, 'color', i.color,
      'kpis', public.resp_kpis(i.slug, p_from, p_to),
      'prev', public.resp_kpis(i.slug, p_from - v_len, p_from),
      'customer_msgs', (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                         where m.instance_id = i.id and m.author_type = 'cliente' and m.sent_at >= p_from and m.sent_at < p_to),
      'team_msgs', (select count(*) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                     where m.instance_id = i.id and m.author_type <> 'cliente' and m.sent_at >= p_from and m.sent_at < p_to),
      'active_groups', (select count(distinct m.group_id) from public.messages m join public.groups g on g.id = m.group_id and g.monitored
                         where m.instance_id = i.id and m.sent_at >= p_from and m.sent_at < p_to),
      'monitored_groups', (select count(*) from public.groups g where g.instance_id = i.id and g.monitored),
      'conversations', (select count(*) from public.conversations c join public.groups g on g.id = c.group_id and g.monitored
                         where c.instance_id = i.id and c.started_at >= p_from and c.started_at < p_to),
      'waiting_now', (select count(*) from public.groups g where g.instance_id = i.id and g.monitored and g.waiting_since is not null),
      'waiting_breached', (select count(*) from public.groups g where g.instance_id = i.id and g.monitored and g.waiting_since is not null
                             and public.effective_seconds(g.waiting_since, now()) > coalesce(g.sla_minutes, s.default_sla_minutes) * 60),
      'open_cases', (select count(*) from public.conversations c join public.groups g on g.id = c.group_id and g.monitored
                      where c.instance_id = i.id and c.case_status = 'aberto' and c.customer_msgs > 0
                        and coalesce(c.case_next_step, 'equipe') <> 'cliente'
                        and c.last_message_at > now() - interval '7 days'),
      'closed_cases', (select count(*) from public.conversations c
                        where c.instance_id = i.id and c.case_status = 'encerrado'
                          and c.case_closed_at >= p_from and c.case_closed_at < p_to),
      'analyzed', (select count(*) from public.conversations c
                    where c.instance_id = i.id and c.sentiment is not null and c.last_message_at >= p_from and c.last_message_at < p_to),
      'negative', (select count(*) from public.conversations c
                    where c.instance_id = i.id and c.sentiment in ('negativo', 'irritado')
                      and c.last_message_at >= p_from and c.last_message_at < p_to),
      'quality', (select round(avg(c.quality_score), 1) from public.conversations c
                   where c.instance_id = i.id and c.quality_score is not null
                     and c.last_message_at >= p_from and c.last_message_at < p_to),
      'top_attendant', (select jsonb_build_object('name', a.name, 'responses', count(*))
                          from public.v_responses r join public.attendants a on a.id = r.attendant_id
                         where r.instance_slug = i.slug and r.responded_at >= p_from and r.responded_at < p_to
                         group by a.name order by count(*) desc limit 1)
    ) order by i.name) from public.instances i), '[]'::jsonb);
end $$;
