-- =====================================================================
-- Chamados técnicos para a equipe interna.
-- Abertos automaticamente quando o cliente fala de Discador, APPCRC, WhatsApp Oficial / API Oficial /
-- ZapIcom, Ramal (extra, em inglês…) ou relata problema técnico ("não está funcionando", "erro", "caiu"…).
-- Assuntos de Facebook / Google (marketing) ficam de fora. Um chamado aberto por grupo: novas menções
-- somam no mesmo chamado. A revisão diária da IA também abre chamados que as palavras-chave não pegaram.
-- =====================================================================

create table if not exists public.tickets (
  id              uuid primary key default gen_random_uuid(),
  number          bigint generated always as identity,
  instance_id     uuid not null references public.instances(id) on delete cascade,
  group_id        uuid not null references public.groups(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id      uuid references public.messages(id) on delete set null,
  source          text not null check (source in ('auto', 'ia', 'manual')),
  product         text not null default 'tecnico'
                  check (product in ('discador', 'appcrc', 'whatsapp_oficial', 'ramal', 'tecnico')),
  customer_name   text,
  trigger_text    text,
  summary         text,
  mentions        int not null default 1,
  status          text not null default 'aberto' check (status in ('aberto', 'andamento', 'resolvido', 'descartado')),
  assignee        text,
  note            text,
  opened_at       timestamptz not null,
  last_mention_at timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz,
  closed_by       text
);
create index if not exists tickets_group_idx  on public.tickets (group_id, last_mention_at desc);
create index if not exists tickets_status_idx on public.tickets (status, opened_at desc);
alter table public.tickets enable row level security;

-- Texto sem acento e em minúsculas.
create or replace function public.norm_text(p text)
returns text language sql immutable as $$
  select lower(translate(coalesce(p, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc'))
$$;

-- Qual assunto técnico a mensagem traz (null = nenhum).
create or replace function public.tech_detect(p text)
returns text language plpgsql immutable as $$
declare v text := public.norm_text(p);
begin
  if v = '' then return null; end if;
  if v ~ 'discador' then return 'discador'; end if;
  if v ~ 'app ?crc|\mcrc\M' then return 'appcrc'; end if;
  if v ~ 'whats ?(app)? ?(business )?oficial|api (do whats ?(app)? )?oficial|zap ?icom|api do whats' then return 'whatsapp_oficial'; end if;
  if v ~ '\mrama(l|is)\M' then return 'ramal'; end if;
  if v ~ ('problema|nao (esta |ta |tah )?funcionando|nao funciona|parou de funcionar|\mparou\M|nao consigo|\merros?\M'
          || '|travou|travando|\mtrava\M|\mcaiu\M|fora do ar|nao abre|nao carrega|nao conecta|desconect|\mbugs?\M'
          || '|instavel|sem acesso|em ingles|nao (esta |ta )?(ligando|tocando|chamando|completando|recebendo|enviando)'
          || '|sem sinal|sem audio|sem som|\mmudo\M|defeito|lentidao|\mlento\M|deu ruim|nao liga\M|tela preta|sem internet')
     and v !~ 'facebook|\mfb\M|google|instagram|\minsta\M|meta ads|anuncio|campanha|trafego|\mads\M|\mpost' then
    return 'tecnico';
  end if;
  return null;
end $$;

-- Registra uma menção técnica: soma no chamado aberto do grupo ou abre um novo.
create or replace function public.ticket_register(p_msg uuid, p_product text, p_source text, p_summary text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare m public.messages; t public.tickets; v_id uuid;
begin
  select * into m from public.messages where id = p_msg;
  if m.id is null then return null; end if;
  -- já tratado: chamado encerrado por alguém depois dessa mensagem, ou menção já contada
  if exists (select 1 from public.tickets x where x.group_id = m.group_id and x.last_mention_at >= m.sent_at
              and (x.status in ('resolvido', 'descartado') or p_source = 'auto')) then
    return null;
  end if;

  select * into t from public.tickets
   where group_id = m.group_id and status in ('aberto', 'andamento') order by opened_at desc limit 1;
  if t.id is not null then
    update public.tickets set
      mentions        = mentions + case when p_source = 'auto' then 1 else 0 end,
      last_mention_at = greatest(last_mention_at, m.sent_at),
      product         = case when product = 'tecnico' and p_product <> 'tecnico' then p_product else product end,
      summary         = coalesce(nullif(p_summary, ''), summary),
      conversation_id = coalesce(m.conversation_id, conversation_id),
      updated_at      = now()
     where id = t.id;
    return t.id;
  end if;

  insert into public.tickets (instance_id, group_id, conversation_id, message_id, source, product, customer_name,
                              trigger_text, summary, opened_at, last_mention_at)
  values (m.instance_id, m.group_id, m.conversation_id, m.id, p_source, coalesce(p_product, 'tecnico'), m.sender_name,
          left(coalesce(m.content, '[' || m.message_type || ']'), 500), nullif(p_summary, ''), m.sent_at, m.sent_at)
  returning id into v_id;
  return v_id;
end $$;

-- Mensagem do cliente entrou na conversa → confere se é assunto técnico.
create or replace function public.tickets_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_product text;
begin
  if new.author_type = 'cliente' and new.sent_at > now() - interval '3 days'
     and exists (select 1 from public.groups g where g.id = new.group_id and g.monitored) then
    v_product := public.tech_detect(new.content);
    if v_product is not null then
      perform public.ticket_register(new.id, v_product, 'auto');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists messages_tickets on public.messages;
create trigger messages_tickets
  after update of conversation_id on public.messages
  for each row when (old.conversation_id is null and new.conversation_id is not null)
  execute function public.tickets_on_message();

-- Chamados apontados pela IA na revisão de casos: [{conversation_id, product, summary}]
create or replace function public.ai_save_tickets(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare r jsonb; v_msg uuid; n int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    select m.id into v_msg from public.messages m
     where m.conversation_id = (r ->> 'conversation_id')::uuid and m.author_type = 'cliente'
     order by m.sent_at desc limit 1;
    if v_msg is null then continue; end if;
    if public.ticket_register(v_msg,
         case when r ->> 'product' in ('discador', 'appcrc', 'whatsapp_oficial', 'ramal') then r ->> 'product' else 'tecnico' end,
         'ia', left(r ->> 'summary', 300)) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Tela de chamados.
create or replace function public.dash_tickets(p_instance text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x order by x.ord, x.last_mention_at desc) from (
      select t.id, t.number, t.status, t.product, t.source, t.customer_name, t.trigger_text, t.summary, t.mentions,
             t.assignee, t.note, t.opened_at, t.last_mention_at, t.closed_at, t.closed_by, t.conversation_id, t.group_id,
             g.name as group_name, i.name as instance_name, i.color as instance_color,
             (select left(coalesce(m.content, '[' || m.message_type || ']'), 300) from public.messages m
               where m.group_id = t.group_id and m.author_type = 'cliente' order by m.sent_at desc limit 1) as last_customer_text,
             case t.status when 'aberto' then 0 when 'andamento' then 1 else 2 end as ord
        from public.tickets t
        join public.groups g on g.id = t.group_id
        join public.instances i on i.id = t.instance_id
       where public.inst_match(p_instance, i.slug)
         and (t.status in ('aberto', 'andamento') or t.closed_at > now() - interval '30 days')
    ) x), '[]'::jsonb),
    'counts', (select jsonb_build_object(
        'aberto',     count(*) filter (where t.status = 'aberto'),
        'andamento',  count(*) filter (where t.status = 'andamento'),
        'resolvido7', count(*) filter (where t.status = 'resolvido' and t.closed_at > now() - interval '7 days'),
        'descartado7', count(*) filter (where t.status = 'descartado' and t.closed_at > now() - interval '7 days'),
        'resolve_hours', round((percentile_cont(0.5) within group (order by extract(epoch from (t.closed_at - t.opened_at)) / 3600.0)
                           filter (where t.status = 'resolvido' and t.closed_at > now() - interval '30 days'))::numeric, 1))
      from public.tickets t join public.instances i on i.id = t.instance_id
     where public.inst_match(p_instance, i.slug)));
end $$;

-- Assumir / resolver / descartar / reabrir (qualquer usuário do painel).
create or replace function public.ticket_set(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_who text;
begin
  perform public.require_user();
  if p_status not in ('aberto', 'andamento', 'resolvido', 'descartado') then raise exception 'Status inválido.'; end if;
  v_who := coalesce((select coalesce(name, email) from public.user_roles where user_id = auth.uid()), auth.jwt() ->> 'email');
  update public.tickets set
    status     = p_status,
    assignee   = case when p_status = 'andamento' then v_who when p_status = 'aberto' then null else coalesce(assignee, v_who) end,
    closed_at  = case when p_status in ('resolvido', 'descartado') then now() end,
    closed_by  = case when p_status in ('resolvido', 'descartado') then v_who end,
    note       = coalesce(nullif(trim(p_note), ''), note),
    updated_at = now()
   where id = p_id;
end $$;

-- Últimos 3 dias: abre os chamados do que já chegou.
do $$
declare r record;
begin
  for r in select m.id, public.tech_detect(m.content) as product
             from public.messages m join public.groups g on g.id = m.group_id and g.monitored
            where m.author_type = 'cliente' and m.sent_at > now() - interval '3 days'
              and public.tech_detect(m.content) is not null
            order by m.sent_at loop
    perform public.ticket_register(r.id, r.product, 'auto');
  end loop;
end $$;
