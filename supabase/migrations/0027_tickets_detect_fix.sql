-- Ajuste da detecção de chamados: só abre quando há sinal de PROBLEMA (o produto define o assunto).
-- Citar o produto sem reclamar ("cadastrando no APPCRC", "nossa CRC") não abre chamado.
-- Relatórios automáticos de robôs ("*RELATÓRIO DIÁRIO IA*…") e textos longos são ignorados.
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
  if v2 !~ ('problema|nao (esta |ta |tah )?funcionando|nao funciona|parou de funcionar|\mparou\M|nao consigo|\merros?\M'
            || '|travou|travando|\mtrava\M|\mcaiu\M|fora do ar|nao abre|nao carrega|nao conecta|desconect|\mbugs?\M'
            || '|instavel|sem acesso|\mingles\M|nao (esta |ta )?(ligando|tocando|chamando|completando|recebendo|enviando)'
            || '|sem sinal|sem audio|sem som|\mmudo\M|defeito|lentidao|\mlento\M|deu ruim|nao liga\M|tela preta|sem internet'
            || '|duplicidade|duplicad|banid|bloquead|qr ?cod') then
    return null;
  end if;

  v_product := case
    when v ~ 'discador' then 'discador'
    when v ~ 'app ?crc' then 'appcrc'
    when v ~ 'whats ?(app)? ?(business )?oficial|api (do whats ?(app)? )?oficial|zap ?icom|api do whats' then 'whatsapp_oficial'
    when v ~ '\mrama(l|is)\M' then 'ramal'
  end;
  if v_product is not null then return v_product; end if;
  if v ~ 'facebook|\mfb\M|google|instagram|\minsta\M|meta ads|anuncio|campanha|trafego|\mads\M|\mpost' then return null; end if;
  return 'tecnico';
end $$;

-- Remove os chamados automáticos abertos pela regra anterior que a regra nova não abriria
-- (criados na publicação desta funcionalidade, ainda sem ninguém mexer) e refaz os últimos 3 dias.
delete from public.tickets
 where source = 'auto' and status = 'aberto' and assignee is null and note is null
   and public.tech_detect(trigger_text) is null;

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
