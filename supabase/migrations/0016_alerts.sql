-- Tela "Alerta": casos que a supervisão deve acompanhar, com motivo e gravidade.
alter table public.conversations
  add column if not exists alert_ack_at   timestamptz,
  add column if not exists alert_ack_by   text,
  add column if not exists alert_ack_note text;

create or replace function public.dash_alerts(p_instance text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings; out jsonb;
begin
  perform public.require_user();
  select * into s from public.app_settings where id = 1;

  with base as (
    select c.*, g.name as group_name, i.slug as instance_slug, i.name as instance_name, i.color as instance_color,
           oa.name as owner_name,
           (g.waiting_message_id is not null and wm.conversation_id = c.id) as waiting,
           case when wm.conversation_id = c.id then public.effective_seconds(g.waiting_since, now()) end as eff_seconds,
           coalesce(g.sla_minutes, s.default_sla_minutes) as sla_minutes,
           case when wm.conversation_id = c.id then
             (select count(*) from public.messages m2 where m2.group_id = g.id and m2.author_type = 'cliente'
                and m2.sent_at >= g.waiting_since) else 0 end as unanswered,
           lower(coalesce(c.category, '') || ' ' || coalesce(c.summary, '') || ' ' || coalesce(c.analysis ->> 'topics', '')) as txt,
           lower(coalesce(c.analysis ->> 'issues', '')) as issues
      from public.conversations c
      join public.groups g on g.id = c.group_id and g.monitored
      join public.instances i on i.id = c.instance_id
      left join public.messages wm on wm.id = g.waiting_message_id
      left join public.attendants oa on oa.id = g.owner_attendant_id
     where c.case_status = 'aberto' and c.customer_msgs > 0
       and c.last_message_at > now() - interval '7 days'
       and public.inst_match(p_instance, i.slug)
  ), reasons as (
    select b.*, (
      select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'label', r.label, 'weight', r.w) order by r.w desc), '[]'::jsonb)
        from (values
          ('irritado', 'Cliente irritado', 5, b.sentiment = 'irritado'),
          ('insatisfeito', 'Cliente insatisfeito', 4, b.sentiment = 'negativo'),
          ('cancelamento', 'Fala em cancelar', 5, b.txt ~ 'cancel|rescis|encerrar contrato|desist'),
          ('espera', 'Esperando mais que o dobro do SLA', 4, b.waiting and b.eff_seconds > b.sla_minutes * 120),
          ('insistindo', 'Cliente insistindo: ' || b.unanswered || ' mensagens sem resposta', 3, b.unanswered >= 3),
          ('sem_retorno', '“Vou verificar” sem retorno', 3, coalesce((b.analysis ->> 'holding_reply_without_followup')::boolean, false)),
          ('promessa', 'Promessa não cumprida', 3, b.issues ~ 'promessa|prometeu|prazo'),
          ('parado', 'Parado há mais de 24h com o time', 2,
             not b.waiting and coalesce(b.case_next_step, 'equipe') = 'equipe' and b.last_message_at < now() - interval '24 hours'),
          ('nota', 'Nota baixa do atendimento (' || coalesce(b.quality_score::text, '') || '/10)', 2, b.quality_score < 6),
          ('satisfacao', 'Satisfação estimada baixa', 2, b.satisfaction <= 2 and coalesce(b.sentiment, '') not in ('negativo', 'irritado'))
        ) as r(code, label, w, hit)
       where r.hit
    ) as rs
      from base b
  ), scored as (
    select r.*, (select coalesce(sum((x ->> 'weight')::int), 0) from jsonb_array_elements(r.rs) x) as score,
           r.alert_ack_at is not null and r.alert_ack_at >= r.last_message_at as acked
      from reasons r
     where jsonb_array_length(r.rs) > 0
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'conversation_id', x.id, 'group_id', x.group_id, 'group_name', x.group_name,
        'instance_slug', x.instance_slug, 'instance_name', x.instance_name, 'instance_color', x.instance_color,
        'last_message_at', x.last_message_at, 'started_at', x.started_at,
        'summary', x.summary, 'case_reason', x.case_reason, 'category', x.category, 'sentiment', x.sentiment,
        'owner_name', x.owner_name, 'waiting', x.waiting, 'eff_seconds', x.eff_seconds, 'sla_minutes', x.sla_minutes,
        'reasons', x.rs, 'score', x.score,
        'level', case when x.score >= 5 then 'critico' when x.score >= 3 then 'atencao' else 'observar' end,
        'acked', x.acked, 'ack_at', x.alert_ack_at, 'ack_by', x.alert_ack_by, 'ack_note', x.alert_ack_note
      ) order by x.acked, x.score desc, x.last_message_at), '[]'::jsonb),
    'counts', jsonb_build_object(
        'critico',  count(*) filter (where not x.acked and x.score >= 5),
        'atencao',  count(*) filter (where not x.acked and x.score between 3 and 4),
        'observar', count(*) filter (where not x.acked and x.score < 3),
        'acked',    count(*) filter (where x.acked))
  ) into out
  from scored x;
  return out;
end $$;

-- Supervisão marca que está acompanhando (some da lista até haver mensagem nova).
create or replace function public.alert_ack(p_conversation uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  update public.conversations
     set alert_ack_at = now(),
         alert_ack_by = coalesce((select coalesce(name, email) from public.user_roles where user_id = auth.uid()), auth.jwt() ->> 'email'),
         alert_ack_note = nullif(trim(p_note), '')
   where id = p_conversation;
end $$;

create or replace function public.alert_unack(p_conversation uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  update public.conversations set alert_ack_at = null, alert_ack_by = null, alert_ack_note = null where id = p_conversation;
end $$;
