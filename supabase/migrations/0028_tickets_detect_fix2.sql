-- Segundo ajuste da detecção:
--  * "caiu lead", "lead duplicado" (marketing) não abrem; "não consigo" só com ação técnica (acessar, entrar…);
--  * mesmo grupo nos dois números (Black e Redes) = um chamado só.
create or replace function public.tech_detect(p text)
returns text language plpgsql immutable as $$
declare
  v  text := public.norm_text(p);
  v2 text;
  v_product text;
begin
  if v = '' or length(v) > 800 then return null; end if;
  if v ~ '^\W*(relatorio|informacoes gerais|resumo)' or v ~ 'relatorio diario' then return null; end if;

  v2 := regexp_replace(v, 'sem problemas?|nao tem problema|problema nenhum|nenhum problema|sem erro', ' ', 'g');
  if v2 !~ ('problema|nao (esta |ta |tah )?funcionando|nao funciona|parou de funcionar|\mparou\M|\merros?\M'
            || '|nao (estou )?consigo (mais )?(acessar|entrar|logar|ligar|abrir|enviar|mandar|receber|baixar|fazer (o )?down|conectar|usar|discar|ouvir)'
            || '|travou|travando|\mtrava\M|\mcaiu\M|fora do ar|nao abre|nao carrega|nao conecta|desconect|\mbugs?\M'
            || '|instavel|sem acesso|\mingles\M|nao (esta |ta )?(ligando|tocando|chamando|completando|recebendo|enviando)'
            || '|sem sinal|sem audio|sem som|\mmudo\M|defeito|lentidao|\mlento\M|deu ruim|nao liga\M|tela preta|sem internet'
            || '|duplicidade|duplicad|banid|qr ?cod') then
    return null;
  end if;

  v_product := case
    when v ~ 'discador' then 'discador'
    when v ~ 'app ?crc' then 'appcrc'
    when v ~ 'whats ?(app)? ?(business )?oficial|api (do whats ?(app)? )?oficial|zap ?icom|api do whats' then 'whatsapp_oficial'
    when v ~ '\mrama(l|is)\M' then 'ramal'
  end;
  if v_product is not null then return v_product; end if;
  if v ~ 'facebook|\mfb\M|google|instagram|\minsta\M|meta ads|anuncio|campanha|trafego|\mads\M|\mpost|\mleads?\M' then return null; end if;
  return 'tecnico';
end $$;

-- Mesmo grupo de WhatsApp monitorado pelos dois números conta como um grupo só.
create or replace function public.ticket_register(p_msg uuid, p_product text, p_source text, p_summary text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare m public.messages; t public.tickets; v_id uuid; v_groups uuid[];
begin
  select * into m from public.messages where id = p_msg;
  if m.id is null then return null; end if;
  select array_agg(g2.id) into v_groups
    from public.groups g1 join public.groups g2 on g2.wa_id = g1.wa_id where g1.id = m.group_id;

  if exists (select 1 from public.tickets x where x.group_id = any(v_groups) and x.last_mention_at >= m.sent_at
              and (x.status in ('resolvido', 'descartado') or p_source = 'auto')) then
    return null;
  end if;

  select * into t from public.tickets
   where group_id = any(v_groups) and status in ('aberto', 'andamento') order by opened_at desc limit 1;
  if t.id is not null then
    update public.tickets set
      mentions        = mentions + case when p_source = 'auto' then 1 else 0 end,
      last_mention_at = greatest(last_mention_at, m.sent_at),
      product         = case when product = 'tecnico' and p_product <> 'tecnico' then p_product else product end,
      summary         = coalesce(nullif(p_summary, ''), summary),
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

-- Refaz os chamados automáticos abertos hoje na publicação (ninguém mexeu ainda) com as regras novas.
delete from public.tickets
 where source = 'auto' and status = 'aberto' and assignee is null and note is null
   and created_at > now() - interval '1 day';

do $$
declare r record;
begin
  for r in select m.id, public.tech_detect(m.content) as product
             from public.messages m join public.groups g on g.id = m.group_id and g.monitored
            where m.author_type = 'cliente' and m.sent_at > now() - interval '3 days'
              and public.tech_detect(m.content) is not null
            order by m.sent_at, m.received_at loop
    perform public.ticket_register(r.id, r.product, 'auto');
  end loop;
end $$;
