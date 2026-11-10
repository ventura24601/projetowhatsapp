-- =====================================================================
-- Núcleo: autenticação, ingestão Z-API, cálculo de tempo de resposta
-- =====================================================================

-- ---------- Auth helpers ----------
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.user_roles where user_id = auth.uid()
$$;

create or replace function public.require_user()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or public.current_role_name() is null then
    raise exception 'Acesso negado: faça login.' using errcode = '42501';
  end if;
end $$;

create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(public.current_role_name(), '') <> 'admin' then
    raise exception 'Apenas administradores podem fazer isso.' using errcode = '42501';
  end if;
end $$;

-- Primeiro usuário que entrar vira admin; os demais entram como "viewer".
create or replace function public.whoami()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role text; v_email text := auth.jwt() ->> 'email';
begin
  if auth.uid() is null then
    raise exception 'Acesso negado: faça login.' using errcode = '42501';
  end if;
  select role into v_role from user_roles where user_id = auth.uid();
  if v_role is null then
    v_role := case when exists (select 1 from user_roles) then 'viewer' else 'admin' end;
    insert into user_roles (user_id, email, role) values (auth.uid(), v_email, v_role)
    on conflict (user_id) do nothing;
  elsif v_email is not null then
    update user_roles set email = v_email where user_id = auth.uid() and email is distinct from v_email;
  end if;
  return jsonb_build_object('user_id', auth.uid(), 'email', v_email, 'role', v_role);
end $$;

-- ---------- Horário comercial ----------
-- Segundos entre a e b que caem dentro do expediente configurado.
create or replace function public.business_seconds(a timestamptz, b timestamptz)
returns int language plpgsql stable set search_path = public as $$
declare
  s public.app_settings;
  d date;
  ds timestamptz;
  de timestamptz;
  total numeric := 0;
begin
  if a is null or b is null or b <= a then return 0; end if;
  select * into s from public.app_settings where id = 1;
  for d in
    select generate_series((a at time zone s.timezone)::date,
                           (b at time zone s.timezone)::date,
                           interval '1 day')::date
  loop
    continue when not (extract(isodow from d)::int = any (s.business_days));
    continue when d = any (s.holidays);
    ds := (d + s.business_start) at time zone s.timezone;
    de := (d + s.business_end)   at time zone s.timezone;
    total := total + greatest(0, extract(epoch from (least(de, b) - greatest(ds, a))));
  end loop;
  return total::int;
end $$;

-- Tempo "efetivo" conforme a configuração (comercial ou corrido).
create or replace function public.effective_seconds(a timestamptz, b timestamptz)
returns int language sql stable set search_path = public as $$
  select case when s.use_business_hours then public.business_seconds(a, b)
              else greatest(0, extract(epoch from (b - a)))::int end
  from public.app_settings s where s.id = 1
$$;

-- ---------- Mensagens que não abrem espera ("ok", "obrigado", figurinha…) ----------
create or replace function public.is_ack_message(p_type text, p_content text)
returns boolean language sql immutable as $$
  select p_type in ('sticker', 'reaction')
      or (p_type = 'text' and lower(btrim(coalesce(p_content, ''))) ~
          '^(\s*(ok+|okay|obrigad[oa]s?|obg|vlw|valeu|blz|beleza|show|perfeito|certo|top|combinado|[óo]timo|entendi|👍|🙏|👏|😊|❤️)[\s!.,]*)+$')
$$;

-- ---------- Quem é o atendente pelo telefone / lid ----------
create or replace function public.match_attendant(p_phone text, p_lid text)
returns uuid language sql stable set search_path = public as $$
  select a.id from public.attendants a
  where (p_phone is not null and a.phone_key = public.phone_key(p_phone))
     or (p_lid is not null and p_lid <> '' and a.lid = p_lid)
  order by a.active desc
  limit 1
$$;

-- ---------- Aplica uma mensagem à linha do tempo do grupo ----------
-- Atualiza atendimento (conversa), espera do cliente e gera evento de resposta.
create or replace function public.apply_message(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m     public.messages;
  g     public.groups;
  s     public.app_settings;
  inst  public.instances;
  c     public.conversations;
  v_team boolean;
  v_sla  int;
  v_secs int;
  v_bsecs int;
  v_eff  int;
begin
  select * into m from public.messages where id = p_id;
  if m.id is null then return; end if;
  select * into g from public.groups where id = m.group_id for update;
  select * into s from public.app_settings where id = 1;
  select * into inst from public.instances where id = m.instance_id;

  v_team := m.author_type = 'atendente' or (m.author_type = 'supervisor' and inst.supervisor_is_team);

  -- atendimento atual ou novo (não quebra enquanto o cliente está esperando)
  select * into c from public.conversations
   where group_id = g.id order by started_at desc limit 1;
  if c.id is null
     or (g.waiting_since is null
         and m.sent_at - c.last_message_at > make_interval(mins => s.conversation_gap_minutes)) then
    insert into public.conversations (instance_id, group_id, started_at, last_message_at)
    values (m.instance_id, g.id, m.sent_at, m.sent_at)
    returning * into c;
  end if;

  update public.messages set conversation_id = c.id where id = m.id;

  if m.author_type = 'cliente' then
    update public.conversations
       set customer_msgs     = customer_msgs + 1,
           last_message_at   = greatest(last_message_at, m.sent_at),
           first_customer_at = coalesce(first_customer_at, m.sent_at)
     where id = c.id;
    if m.opens_wait and g.waiting_since is null then
      update public.groups set waiting_since = m.sent_at, waiting_message_id = m.id where id = g.id;
      update public.conversations set status = 'aguardando_equipe' where id = c.id;
    end if;

  elsif v_team then
    update public.conversations
       set team_msgs = team_msgs + 1,
           last_message_at = greatest(last_message_at, m.sent_at)
     where id = c.id;

    if g.waiting_since is not null and m.sent_at >= g.waiting_since then
      v_sla   := coalesce(g.sla_minutes, s.default_sla_minutes);
      v_secs  := greatest(0, extract(epoch from (m.sent_at - g.waiting_since)))::int;
      v_bsecs := public.business_seconds(g.waiting_since, m.sent_at);
      v_eff   := case when s.use_business_hours then v_bsecs else v_secs end;

      insert into public.response_events (
        instance_id, group_id, conversation_id, customer_message_id, team_message_id,
        attendant_id, author_type, waited_from, responded_at,
        response_seconds, business_seconds, sla_minutes, sla_breached, is_first_response)
      values (
        m.instance_id, g.id, c.id, g.waiting_message_id, m.id,
        m.attendant_id, m.author_type, g.waiting_since, m.sent_at,
        v_secs, v_bsecs, v_sla, v_eff > v_sla * 60, c.first_response_at is null);

      update public.conversations
         set status = 'aguardando_cliente',
             first_response_at      = coalesce(first_response_at, m.sent_at),
             first_response_seconds = coalesce(first_response_seconds, v_eff)
       where id = c.id;
      update public.groups set waiting_since = null, waiting_message_id = null where id = g.id;
    end if;
  else
    update public.conversations set last_message_at = greatest(last_message_at, m.sent_at) where id = c.id;
  end if;

  update public.groups
     set last_message_at = greatest(coalesce(last_message_at, m.sent_at), m.sent_at)
   where id = g.id;
end $$;

-- ---------- Ingestão do webhook "Ao receber" da Z-API ----------
create or replace function public.ingest_zapi(p_slug text, p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  inst      public.instances;
  v_from_me boolean := coalesce((p ->> 'fromMe')::boolean, false);
  v_phone   text;
  v_lid     text := nullif(p ->> 'participantLid', '');
  v_group   uuid;
  v_att     uuid;
  v_author  text;
  v_type    text;
  v_content text;
  v_sent    timestamptz;
  v_id      uuid;
begin
  select * into inst from public.instances where slug = p_slug;
  if inst.id is null then
    return jsonb_build_object('ok', false, 'status', 404, 'error', 'instance_not_found');
  end if;
  if p_secret is distinct from inst.webhook_secret then
    return jsonb_build_object('ok', false, 'status', 401, 'error', 'unauthorized');
  end if;

  update public.instances
     set last_event_at   = now(),
         connected_phone = coalesce(nullif(p ->> 'connectedPhone', ''), connected_phone)
   where id = inst.id;

  if not inst.active then
    return jsonb_build_object('ok', true, 'skipped', 'instance_inactive');
  end if;
  if coalesce(p ->> 'type', 'ReceivedCallback') <> 'ReceivedCallback' then
    return jsonb_build_object('ok', true, 'skipped', 'type:' || (p ->> 'type'));
  end if;
  if not coalesce((p ->> 'isGroup')::boolean, false) then
    return jsonb_build_object('ok', true, 'skipped', 'not_group');
  end if;
  if nullif(p ->> 'notification', '') is not null then
    return jsonb_build_object('ok', true, 'skipped', 'notification');
  end if;
  if jsonb_typeof(p -> 'reaction') = 'object' then
    return jsonb_build_object('ok', true, 'skipped', 'reaction');
  end if;
  if coalesce((p ->> 'isNewsletter')::boolean, false) or coalesce((p ->> 'isStatusReply')::boolean, false) then
    return jsonb_build_object('ok', true, 'skipped', 'status_or_newsletter');
  end if;
  if coalesce(p ->> 'messageId', '') = '' or coalesce(p ->> 'phone', '') = '' then
    return jsonb_build_object('ok', false, 'status', 400, 'error', 'missing_messageId_or_phone');
  end if;

  -- grupo
  insert into public.groups (instance_id, wa_id, name)
  values (inst.id, p ->> 'phone', coalesce(nullif(p ->> 'chatName', ''), p ->> 'phone'))
  on conflict (instance_id, wa_id) do update
     set name = case when excluded.name <> excluded.wa_id then excluded.name else public.groups.name end
  returning id into v_group;

  -- autor
  if v_from_me then
    v_phone  := coalesce(nullif(p ->> 'connectedPhone', ''), inst.connected_phone);
    v_author := 'supervisor';
    v_att    := null;
  else
    v_phone  := nullif(p ->> 'participantPhone', '');
    v_att    := public.match_attendant(v_phone, v_lid);
    v_author := case when v_att is null then 'cliente' else 'atendente' end;
  end if;

  -- tipo / conteúdo
  if nullif(p #>> '{text,message}', '') is not null then
    v_type := 'text';     v_content := p #>> '{text,message}';
  elsif jsonb_typeof(p -> 'image') = 'object' then
    v_type := 'image';    v_content := coalesce(nullif(p #>> '{image,caption}', ''), '[imagem]');
  elsif jsonb_typeof(p -> 'audio') = 'object' then
    v_type := 'audio';    v_content := '[áudio]';
  elsif jsonb_typeof(p -> 'video') = 'object' then
    v_type := 'video';    v_content := coalesce(nullif(p #>> '{video,caption}', ''), '[vídeo]');
  elsif jsonb_typeof(p -> 'document') = 'object' then
    v_type := 'document';
    v_content := coalesce(nullif(p #>> '{document,caption}', ''),
                          '[documento' || coalesce(': ' || nullif(p #>> '{document,fileName}', ''), '') || ']');
  elsif jsonb_typeof(p -> 'sticker') = 'object' then
    v_type := 'sticker';  v_content := '[figurinha]';
  elsif jsonb_typeof(p -> 'location') = 'object' then
    v_type := 'location'; v_content := '[localização]';
  elsif jsonb_typeof(p -> 'contact') = 'object' then
    v_type := 'contact';  v_content := '[contato]';
  elsif jsonb_typeof(p -> 'buttonsResponseMessage') = 'object' then
    v_type := 'text';     v_content := p #>> '{buttonsResponseMessage,message}';
  else
    v_type := 'other';    v_content := null;
  end if;

  v_sent := case when (p ->> 'momment') ~ '^\d+$'
                 then to_timestamp((p ->> 'momment')::bigint / 1000.0)
                 else now() end;

  insert into public.messages (
    instance_id, group_id, external_id, from_me, sender_phone, sender_lid, sender_name,
    author_type, attendant_id, message_type, content, opens_wait, sent_at)
  values (
    inst.id, v_group, p ->> 'messageId', v_from_me,
    regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), v_lid, nullif(p ->> 'senderName', ''),
    v_author, v_att, v_type, v_content, not public.is_ack_message(v_type, v_content), v_sent)
  on conflict (instance_id, external_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  perform public.apply_message(v_id);
  return jsonb_build_object('ok', true, 'message_id', v_id, 'author', v_author);
end $$;

-- ---------- Reprocessa um grupo inteiro (após cadastrar atendente, mudar SLA etc.) ----------
create or replace function public.rebuild_group(p_group uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  create temp table if not exists _ai_keep (like public.conversations including defaults) on commit drop;
  delete from _ai_keep;
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
