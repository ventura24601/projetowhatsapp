// Servidor local de demonstração: Postgres embutido (PGlite) + emulação do endpoint RPC do Supabase
// + webhook Z-API. Não precisa de Supabase nem Netlify para testar o painel.
import http from "node:http";
import { createLocalDb, asUser, rpc, DEMO_USER } from "./pg-local.mjs";
import { seedDemo } from "./seed.mjs";
import { handleZapiWebhook } from "../netlify/lib/webhook.mjs";
import { collectAnalysisBatches, submitAnalysisBatch } from "../netlify/lib/analyze.mjs";
import { submitCaseBatch } from "../netlify/lib/cases.mjs";

const PORT = Number(process.env.API_PORT || 8787);
const db = await createLocalDb();
await asUser(db, DEMO_USER);
await rpc(db, "whoami");
if (process.env.NO_SEED !== "1") {
  console.log("[demo] gerando dados simulados…");
  console.log("[demo]", await seedDemo(db));
}

// PGlite tem uma conexão só: serializa as chamadas.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));
const call = (fn, args) => serial(() => rpc(db, fn, args));

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const send = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      let m;
      if ((m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)) && req.method === "POST") {
        const raw = await body(req);
        return send(res, 200, await call(m[1], raw ? JSON.parse(raw) : {}));
      }
      if ((m = url.pathname.match(/^\/api\/zapi\/([a-z0-9-]+)$/))) {
        const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === "POST" ? await body(req) : undefined });
        const r = await handleZapiWebhook(request, m[1], call);
        return send(res, r.status, await r.json());
      }
      if (url.pathname === "/api/analyze-now" && req.method === "POST") {
        await collectAnalysisBatches(call);
        const r = await submitAnalysisBatch(call, { idleMinutes: 15 });
        return send(res, r.ok ? 200 : 400, r);
      }
      if (url.pathname === "/api/cases-review-now" && req.method === "POST") {
        await collectAnalysisBatches(call);
        const r = await submitCaseBatch(call);
        return send(res, r.ok ? 200 : 400, r);
      }
      send(res, 404, { message: "not found" });
    } catch (e) {
      send(res, 400, { message: e.message });
    }
  })
  .listen(PORT, () => console.log(`[demo] API local em http://localhost:${PORT}`));
