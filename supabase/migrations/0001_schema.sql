-- =====================================================================
-- Monitor de Atendimento WhatsApp (Z-API) — schema
-- Toda leitura/escrita do painel passa por funções RPC (security definer).
-- As tabelas ficam com RLS ligado e sem policies: ninguém lê direto.
-- =====================================================================

-- ---------- Configurações gerais (linha única) ----------
create table public.app_settings (
  id                       int primary key default 1 check (id = 1),
  timezone                 text    not null default 'America/Sao_Paulo',
  business_days            int[]   not null default '{1,2,3,4,5}',   -- ISO: 1=seg … 7=dom
  business_start           time    not null default '08:00',
  business_end             time    not null default '18:00',
  holidays                 date[]  not null default '{}',
  use_business_hours       boolean not null default true,
  default_sla_minutes      int     not null default 30,
  conversation_gap_minutes int     not null default 240,             -- silêncio que encerra um atendimento
  categories               text[]  not null default array[
    'Dúvida', 'Suporte técnico', 'Solicitação de alteração', 'Problema / erro',
    'Financeiro / cobrança', 'Cancelamento', 'Reclamação', 'Elogio', 'Agendamento', 'Outros'
  ],
  updated_at               timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

-- ---------- Papéis de usuário do painel ----------
create table public.user_roles (
  user_id    uuid primary key,
  email      text,
  role       text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

-- ---------- Números monitorados (uma instância Z-API por produto) ----------
create table public.instances (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name               text not null,
  color              text not null default '#3b82f6',
  connected_phone    text,
  webhook_secret     text not null default replace(gen_random_uuid()::text, '-', ''),
  supervisor_is_team boolean not null default true,  -- mensagens do próprio número contam como resposta do time
  active             boolean not null default true,
  last_event_at      timestamptz,
  created_at         timestamptz not null default now()
);
insert into public.instances (slug, name, color) values
  ('black', 'Black', '#141d38'),
  ('redes', 'Redes', '#2563eb');

-- ---------- Telefone → chave canônica (DDD + 8 últimos dígitos) ----------
-- Resolve 55 / sem 55 e o nono dígito: 5511987654321, 11987654321 e 1187654321 → 1187654321
create or replace function public.phone_key(p text)
returns text language sql immutable as $$
  with d as (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as v),
       n as (select case when length(v) in (12, 13) and v like '55%' then substr(v, 3) else v end as v from d)
  select case
           when v = '' then null
           when length(v) in (10, 11) then substr(v, 1, 2) || right(v, 8)
           else v
         end
  from n
$$;

-- ---------- Atendentes (números do time) ----------
create table public.attendants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text not null,
  phone_key  text generated always as (public.phone_key(phone)) stored,
  lid        text,                       -- id @lid do WhatsApp, quando o número vier mascarado
  area       text,
  products   text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index attendants_phone_key_uq on public.attendants (phone_key);

-- ---------- Grupos ----------
create table public.groups (
  id                  uuid primary key default gen_random_uuid(),
  instance_id         uuid not null references public.instances(id) on delete cascade,
  wa_id               text not null,
  name                text not null,
  sla_minutes         int,                -- null = padrão das configurações
  owner_attendant_id  uuid references public.attendants(id) on delete set null,
  monitored           boolean not null default true,
  notes               text,
  waiting_since       timestamptz,        -- 1ª mensagem do cliente ainda sem resposta
  waiting_message_id  uuid,
  last_message_at     timestamptz,
  created_at          timestamptz not null default now(),
  unique (instance_id, wa_id)
);

-- ---------- Atendimentos (janelas de conversa) ----------
create table public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  instance_id            uuid not null references public.instances(id) on delete cascade,
  group_id               uuid not null references public.groups(id) on delete cascade,
  started_at             timestamptz not null,
  last_message_at        timestamptz not null,
  first_customer_at      timestamptz,
  first_response_at      timestamptz,
  first_response_seconds int,
  customer_msgs          int not null default 0,
  team_msgs              int not null default 0,
  status                 text not null default 'aguardando_cliente'
                         check (status in ('aguardando_equipe', 'aguardando_cliente')),
  -- análise de IA
  analyzed_at            timestamptz,
  category               text,
  sentiment              text,
  satisfaction           int,
  quality_score          numeric(4,1),
  resolved               boolean,
  pending_on             text,
  summary                text,
  analysis               jsonb,
  analysis_model         text,
  created_at             timestamptz not null default now()
);
create index conversations_group_idx    on public.conversations (group_id, started_at desc);
create index conversations_started_idx  on public.conversations (started_at desc);
create index conversations_pending_ai   on public.conversations (last_message_at) where analyzed_at is null;

-- ---------- Mensagens ----------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  instance_id     uuid not null references public.instances(id) on delete cascade,
  group_id        uuid not null references public.groups(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  external_id     text not null,
  from_me         boolean not null default false,
  sender_phone    text,
  sender_lid      text,
  sender_name     text,
  author_type     text not null check (author_type in ('cliente', 'atendente', 'supervisor')),
  attendant_id    uuid references public.attendants(id) on delete set null,
  message_type    text not null default 'text',
  content         text,
  opens_wait      boolean not null default true,  -- falso p/ "ok", "obrigado", figurinha…
  sent_at         timestamptz not null,
  received_at     timestamptz not null default now(),
  unique (instance_id, external_id)
);
create index messages_group_sent_idx on public.messages (group_id, sent_at);
create index messages_sent_idx       on public.messages (sent_at desc);
create index messages_conv_idx       on public.messages (conversation_id, sent_at);
create index messages_sender_idx     on public.messages (instance_id, sender_phone);

-- ---------- Eventos de resposta (base do tempo de resposta) ----------
create table public.response_events (
  id                  uuid primary key default gen_random_uuid(),
  instance_id         uuid not null references public.instances(id) on delete cascade,
  group_id            uuid not null references public.groups(id) on delete cascade,
  conversation_id     uuid references public.conversations(id) on delete set null,
  customer_message_id uuid references public.messages(id) on delete cascade,
  team_message_id     uuid references public.messages(id) on delete cascade,
  attendant_id        uuid references public.attendants(id) on delete set null,
  author_type         text not null,
  waited_from         timestamptz not null,
  responded_at        timestamptz not null,
  response_seconds    int not null,   -- relógio corrido
  business_seconds    int not null,   -- só horário comercial
  sla_minutes         int not null,
  sla_breached        boolean not null,
  is_first_response   boolean not null default false
);
create index response_events_resp_idx  on public.response_events (responded_at desc);
create index response_events_att_idx   on public.response_events (attendant_id, responded_at desc);
create index response_events_group_idx on public.response_events (group_id, responded_at desc);

alter table public.app_settings    enable row level security;
alter table public.user_roles      enable row level security;
alter table public.instances       enable row level security;
alter table public.attendants      enable row level security;
alter table public.groups          enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.response_events enable row level security;
