-- Corrige rebuild_group: o Supabase (pg_safeupdate) bloqueia DELETE sem WHERE vindo da API,
-- o que fazia o reprocessamento falhar depois de cadastrar atendentes.
create or replace function public.rebuild_group(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  create temp table if not exists _ai_keep (like public.conversations including defaults) on commit drop;
  delete from _ai_keep where true;
  insert into _ai_keep select * from public.conversations where group_id = p_group and analyzed_at is not null;

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
         pending_on = k.pending_on, summary = k.summary, analysis = k.analysis, analysis_model = k.analysis_model
    from _ai_keep k
   where c.group_id = p_group and c.started_at = k.started_at;
  return n;
end $$;
