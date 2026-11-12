// Gera 14 dias de conversas simuladas (payloads no formato Z-API) para o modo demo.
import { rpc } from "./pg-local.mjs";

const ATTENDANTS = [
  { name: "Ana Souza", phone: "5511981110001", area: "Suporte", products: ["black"] },
  { name: "Bruno Lima", phone: "5511981110002", area: "Suporte", products: ["black", "redes"] },
  { name: "Carla Mendes", phone: "5511981110003", area: "CS", products: ["redes"] },
  { name: "Diego Rocha", phone: "5511981110004", area: "Atendimento", products: ["redes"] },
  { name: "Elisa Prado", phone: "5511981110005", area: "CS", products: ["black"] },
];
// Um integrante do time ainda não cadastrado (aparece em "Números não cadastrados")
const HELPDESK = [
  { name: "Hugo (Helpdesk)", phone: "5511981110010", area: "Helpdesk", products: [], team: "helpdesk" },
  { name: "Iara (Helpdesk)", phone: "5511981110011", area: "Helpdesk", products: [], team: "helpdesk" },
];
const HD_MSGS = ["Pessoal, já reiniciei o player remotamente.", "Atualizei o conteúdo no sistema, confere aí?", "Verifiquei o equipamento, está online agora.", "Abri chamado com o fornecedor, aviso quando voltar."];
const UNREGISTERED = { name: "Fábio (novo)", phone: "5511981110006" };

const CLIENTS = {
  black: ["Clínica Sorriso", "Odonto Prime", "Vet Amigo", "Hospital São Lucas", "Ótica Visão", "Dermato Center",
          "Lab Vida", "Fisio Plus", "Pediatria Feliz", "Academia Pulse", "Studio Bella", "Farmácia Central"],
  redes: ["Rede Mais Saúde", "Grupo Oral Max", "Rede Pet Care", "Supermercados Bom Preço", "Rede Farma Já",
          "Clínicas Integra", "Óticas Lumière", "Rede Fit", "Laboratórios Unilab", "Rede Odonto Sul"],
};

const OPENERS = [
  "Bom dia! A TV da recepção está com a tela preta", "Oi, precisamos trocar o vídeo da campanha de novembro",
  "Boa tarde, o player não liga desde ontem", "Olá, como faço para cancelar um ponto?",
  "Pessoal, a programação está passando o conteúdo antigo", "Bom dia, queria agendar a instalação na nova unidade",
  "Oi! Vocês conseguem incluir o logo novo na barra?", "A TV está sem internet de novo",
  "Boa tarde, recebemos uma cobrança duplicada", "Quando sai o relatório do mês?",
  "Bom dia, a TV ficou mostrando uma mensagem de erro", "Podem mudar o horário de exibição para começar às 7h?",
];
const FOLLOWUPS = ["Alguém consegue ver?", "Segue foto", "É urgente, temos evento hoje", "Conseguiram verificar?", "Ainda está igual"];
const TEAM_REPLIES = [
  "Bom dia! Já estou verificando aqui", "Oi! Vou abrir um chamado com o técnico e te retorno",
  "Olá! Pode reiniciar o player tirando da tomada por 10s?", "Perfeito, já ajustamos a programação",
  "Estamos verificando, já retorno", "Prontinho, conteúdo atualizado. Pode conferir?",
  "Vou encaminhar para o financeiro e te dou retorno ainda hoje", "Agendado para quinta às 10h, ok?",
];
const CLOSERS = ["Obrigado!", "Ok", "👍", "Funcionou, valeu!", "Perfeito, obrigada", "Ainda não funcionou 😕"];

let rnd = 42;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + rand() * (b - a);

export async function seedDemo(db, { days = 14 } = {}) {
  for (const a of [...ATTENDANTS, ...HELPDESK]) await rpc(db, "save_attendant", { p: a });
  const inst = (await db.query(`select slug, webhook_secret from instances`)).rows;
  const secret = Object.fromEntries(inst.map((r) => [r.slug, r.webhook_secret]));

  const events = [];
  let id = 0;
  const now = Date.now();
  for (const slug of ["black", "redes"]) {
    const team = ATTENDANTS.filter((a) => a.products.includes(slug));
    CLIENTS[slug].forEach((client, gi) => {
      const group = `1203630${slug === "black" ? 1 : 2}${String(gi).padStart(10, "0")}-group`;
      const customer = { name: `Contato ${client.split(" ")[0]}`, phone: `55219${String(70000000 + gi * 13 + (slug === "black" ? 0 : 500))}` };
      const slow = gi % 4 === 0; // alguns grupos com atendimento mais lento
      for (let d = days; d >= 0; d--) {
        if (rand() > 0.55) continue;
        const day = new Date(now - d * 86400e3);
        day.setUTCHours(11 + Math.floor(between(0, 9)), Math.floor(between(0, 59)), 0, 0); // 8h–17h BRT
        let t = day.getTime();
        if (t > now - 5 * 60e3) continue;
        const push = (from, text, who) => events.push({ slug, group, client, t, from, text, who, id: ++id });
        push("cliente", pick(OPENERS), customer);
        if (rand() < 0.4) { t += between(1, 6) * 60e3; push("cliente", pick(FOLLOWUPS), customer); }
        // às vezes fica pendente (último dia)
        if (d === 0 && rand() < 0.5) continue;
        const responder = rand() < 0.15 ? "supervisor" : rand() < 0.08 ? UNREGISTERED : pick(team);
        t += (slow ? between(20, 180) : between(2, 40)) * 60e3;
        push(responder === "supervisor" ? "supervisor" : "time", pick(TEAM_REPLIES), responder);
        if (rand() < 0.2) { t += between(3, 45) * 60e3; push("time", pick(HD_MSGS), pick(HELPDESK)); }
        if (rand() < 0.6) {
          t += between(5, 60) * 60e3;
          push("cliente", pick(CLOSERS), customer);
          if (rand() < 0.3) { t += between(3, 30) * 60e3; push("time", "Qualquer coisa estamos à disposição!", pick(team)); }
        }
      }
    });
  }
  events.sort((a, b) => a.t - b.t);

  for (const e of events) {
    if (e.t > now) continue;
    const p = {
      type: "ReceivedCallback", messageId: `DEMO${e.id}`, isGroup: true, phone: e.group, chatName: e.client,
      fromMe: e.from === "supervisor", connectedPhone: e.slug === "black" ? "5511900000001" : "5511900000002",
      participantPhone: e.from === "supervisor" ? null : e.who.phone,
      senderName: e.from === "supervisor" ? "Supervisor" : e.who.name,
      momment: Math.round(e.t), text: { message: e.text },
    };
    await rpc(db, "ingest_zapi", { p_slug: e.slug, p_secret: secret[e.slug], p });
  }

  // Análises de exemplo (no ambiente real vêm do Claude)
  const convs = (await rpc(db, "ai_pending_conversations", { p_limit: 100, p_idle_minutes: 60 })).items;
  const cats = ["Suporte técnico", "Solicitação de alteração", "Problema / erro", "Agendamento", "Financeiro / cobrança", "Dúvida", "Cancelamento"];
  for (const c of convs) {
    const first = c.messages.find((m) => m.author === "cliente")?.text || "";
    const lastCustomer = [...c.messages].reverse().find((m) => m.author === "cliente")?.text || "";
    const unhappy = /não funcionou|urgente|cancelar|duplicada/i.test(c.messages.map((m) => m.text).join(" "));
    const team = [...new Map(c.messages.filter((m) => m.author !== "cliente").map((m) => [m.attendant_id ?? m.name, m])).values()];
    const holding = c.messages.some((m) => m.author !== "cliente" && /verificando|retorno/i.test(m.text || ""));
    const category = /cancelar/i.test(first) ? "Cancelamento" : /cobrança/i.test(first) ? "Financeiro / cobrança"
      : /agendar/i.test(first) ? "Agendamento" : /trocar|incluir|mudar|horário/i.test(first) ? "Solicitação de alteração"
      : /erro|antigo/i.test(first) ? "Problema / erro" : /relatório/i.test(first) ? "Dúvida" : pick(cats.slice(0, 1));
    await rpc(db, "ai_save_analysis", {
      p_conversation: c.id, p_model: "demo",
      p: {
        category, sentiment: unhappy ? (rand() < 0.4 ? "irritado" : "negativo") : rand() < 0.6 ? "positivo" : "neutro",
        satisfaction: unhappy ? 2 : 4, quality_score: Math.round(between(unhappy ? 4 : 6.5, unhappy ? 7 : 9.8) * 10) / 10,
        resolved: !unhappy && /obrigad|valeu|funcionou|👍|ok/i.test(lastCustomer),
        pending_on: unhappy ? "equipe" : "ninguem", holding_reply_without_followup: holding && unhappy,
        summary: `${c.group_name}: ${first.slice(0, 90)}`,
        topics: [first.toLowerCase().includes("tv") ? "tela / tv" : category.toLowerCase()],
        customer_questions: [first.replace(/^(bom dia|boa tarde|oi|olá)[!,.]?\s*/i, "")],
        issues: holding && unhappy ? ["Respondeu \"estamos verificando\" e não retornou com solução"] : [],
        team_feedback: team.map((m) => ({
          attendant_id: m.attendant_id, name: m.name, score: Math.round(between(6, 10) * 10) / 10,
          strengths: "Cordialidade", improve: holding ? "Dar prazo de retorno" : "Confirmar resolução com o cliente",
        })),
      },
    });
  }
  return { messages: events.length, analyzed: convs.length };
}
