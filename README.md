# Monitor de Atendimento WhatsApp (Z-API)

Painel que acompanha o **tempo de resposta do time** nos grupos de WhatsApp dos clientes e analisa as conversas com IA.
Dois números monitorados — **Black** e **Redes** — cada um é o número do supervisor, que está em todos os grupos
daquele produto e recebe as mensagens via webhook da Z-API.

## Como funciona

```
WhatsApp (grupos) ──► Z-API (número do supervisor) ──webhook──► Netlify Function /api/zapi/<black|redes>
                                                                     │
                                                                     ▼
                                                    Supabase (Postgres) · ingest_zapi()
                                     mensagens → atendimentos → eventos de resposta → SLA
                                                                     │
               Netlify Functions agendadas (lote 11h e 16h) ── Claude Batches ──► análise de cada atendimento
                                                                     │
                                                                     ▼
                                                         Painel React (Vite) via RPC
```

- **Quem é time:** os números cadastrados em *Cadastros → Atendentes* + o próprio número do supervisor (mensagens
  “enviadas por mim”). Todo o resto no grupo é cliente. Telefones casam com ou sem `55` e com ou sem o 9º dígito.
- **Tempo de resposta:** quando o cliente escreve, o grupo entra em espera; a primeira mensagem do time encerra a espera
  e gera um evento de resposta. Várias mensagens seguidas do cliente contam a partir da primeira.
  “ok”, “obrigado”, 👍 e figurinhas não abrem espera.
- **Horário comercial:** por padrão só conta o tempo dentro do expediente (seg–sex, 8h–18h, configurável, com feriados).
  Mensagem às 21h respondida às 8h20 = 20 min.
- **SLA:** padrão de 30 min, com SLA específico por grupo.
- **Atendimento:** sequência de mensagens no grupo; termina após 4h de silêncio (nunca enquanto o cliente espera).
- **Análise por IA (Claude):** atendimentos parados há 1h são classificados — motivo, clima do cliente, se foi resolvido,
  com quem está a pendência, nota de qualidade do time (por pessoa), “estamos verificando” sem retorno, perguntas
  frequentes e problemas do atendimento.

### Telas
| Tela | O que mostra |
|---|---|
| Visão geral | mediana / p90 do tempo de resposta, % no SLA, comparação com período anterior, Black × Redes, evolução diária, distribuição, grupos mais atrasados, mapa de calor |
| Aguardando resposta | fila ao vivo de grupos com cliente esperando, ordenada pela espera |
| Equipe | ranking por atendente (+ supervisor): respostas, mediana, % SLA, grupos, nota de qualidade |
| Grupos | métricas por grupo, SLA próprio, responsável, ignorar grupos internos, conversa completa |
| Atendimentos | lista filtrável com resumo da IA e a conversa marcando o tempo de cada resposta |
| Análise (IA) | motivos de contato, clima, resolvidos, quem precisa de atenção, feedback por pessoa, FAQ |
| Cadastros | números monitorados (URL do webhook), atendentes, **números não cadastrados** (quem aparece em vários grupos = provável time), expediente/SLA/categorias, usuários |

## Testar localmente (sem Supabase)

```bash
npm install
npm run dev:api   # Postgres embutido + 14 dias de conversas simuladas (porta 8787)
npm run dev:web   # painel em http://localhost:5180 (modo demonstração)
npm test          # testes da lógica SQL
```

## Colocar no ar

1. **Supabase** – crie um projeto e rode, em ordem, os arquivos de `supabase/migrations/` no SQL Editor
   (ou `supabase db push`). Em *Authentication*, desative cadastro público se quiser e convide os usuários.
   O primeiro usuário que entrar vira **admin**.
2. **Netlify** – conecte este repositório e configure as variáveis do `.env.example`
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`).
3. **Z-API** – para cada instância (Black e Redes):
   - No painel, *Cadastros → Números monitorados*, copie a URL do webhook
     (`https://SEU-SITE/api/zapi/black?token=…`).
   - Na Z-API: instância → *Webhooks* → **Ao receber** = essa URL, e ative **“Notificar as enviadas por mim também”**.
4. Cadastre os números do time em *Cadastros → Atendentes* (ou pela aba *Números não cadastrados*).
   Ao cadastrar alguém depois, o histórico dos grupos dessa pessoa é recalculado.

### Modelo de IA
Padrão `claude-opus-5-5` com esforço baixo. Para reduzir custo em volume alto, defina `ANTHROPIC_MODEL=claude-haiku-5-5`.
O pedido usa fallback automático do servidor caso o modelo recuse uma conversa.

## Estrutura
```
supabase/migrations/   schema, ingestão Z-API, cálculo de SLA, RPCs do painel, permissões
netlify/functions/     zapi-webhook, analyze-scheduled (análise 11h e 16h), cases-scheduled (casos 9h, 13h, 17h), analyze-collect (resultados a cada 5 min), analyze-now, cases-now
netlify/lib/           webhook, análise com Claude, cliente Supabase
src/                   painel React
scripts/               PGlite local, dados simulados, testes
```

## Observações
- **@lid:** em alguns grupos o WhatsApp esconde o telefone e a Z-API envia só um `participantLid`. Nesse caso cadastre
  o *ID @lid* do atendente (campo avançado) — ele aparece na aba *Números não cadastrados*.
- Todas as tabelas têm RLS sem policies; o painel acessa só por funções RPC que conferem login/admin.
