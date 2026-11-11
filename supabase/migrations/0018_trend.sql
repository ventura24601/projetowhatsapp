-- Gráfico de tendência da visão geral: por semana, por dia e por dia da semana.
create or replace function public.trend_rows(p_instance text, p_from timestamptz, p_grain text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz text; out jsonb;
begin
  select timezone into tz from public.app_settings where id = 1;
  with m as (
    select case p_grain
             when 'week' then to_char(date_trunc('week', m.sent_at at time zone tz), 'YYYY-MM-DD')
             when 'day'  then to_char((m.sent_at at time zone tz)::date, 'YYYY-MM-DD')
             else extract(isodow from m.sent_at at time zone tz)::int::text end as k,
           m.author_type, m.group_id
      from public.messages m
      join public.instances i on i.id = m.instance_id
      join public.groups g on g.id = m.group_id and g.monitored
     where m.sent_at >= p_from and public.inst_match(p_instance, i.slug)
  ), r as (
    select case p_grain
             when 'week' then to_char(date_trunc('week', responded_at at time zone tz), 'YYYY-MM-DD')
             when 'day'  then to_char((responded_at at time zone tz)::date, 'YYYY-MM-DD')
             else extract(isodow from responded_at at time zone tz)::int::text end as k,
           eff_seconds, sla_breached
      from public.v_responses
     where responded_at >= p_from and public.inst_match(p_instance, instance_slug)
  ), mm as (
    select k, count(*) filter (where author_type = 'cliente') as customer_msgs,
              count(*) filter (where author_type <> 'cliente') as team_msgs,
              count(distinct group_id) as active_groups
      from m group by k
  ), rr as (
    select k, count(*) as responses,
           percentile_cont(0.5) within group (order by eff_seconds) as median_seconds,
           percentile_cont(0.9) within group (order by eff_seconds) as p90_seconds,
           round(100.0 * avg(case when sla_breached then 0 else 1 end), 1) as sla_pct,
           count(*) filter (where sla_breached) as breached
      from r group by k
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'k', coalesce(mm.k, rr.k),
           'customer_msgs', coalesce(mm.customer_msgs, 0), 'team_msgs', coalesce(mm.team_msgs, 0),
           'active_groups', coalesce(mm.active_groups, 0),
           'responses', coalesce(rr.responses, 0), 'median_seconds', rr.median_seconds,
           'p90_seconds', rr.p90_seconds, 'sla_pct', rr.sla_pct, 'breached', coalesce(rr.breached, 0)
         ) order by coalesce(mm.k, rr.k)), '[]'::jsonb)
    into out
    from mm full join rr on rr.k = mm.k;
  return out;
end $$;

create or replace function public.dash_trend(p_instance text, p_weeks int default 8)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz text; v_from timestamptz;
begin
  perform public.require_user();
  select timezone into tz from public.app_settings where id = 1;
  v_from := (date_trunc('week', now() at time zone tz) - make_interval(weeks => greatest(1, least(p_weeks, 26)) - 1)) at time zone tz;
  return jsonb_build_object(
    'from', v_from,
    'by_week', public.trend_rows(p_instance, v_from, 'week'),
    'by_day',  public.trend_rows(p_instance, v_from, 'day'),
    'by_dow',  public.trend_rows(p_instance, v_from, 'dow'));
end $$;
