// Recebe o webhook "Ao receber" da Z-API. A lógica toda fica no SQL (ingest_zapi).
// URL configurada na Z-API: https://SEU-SITE/api/zapi/<slug>?token=<segredo>
export async function handleZapiWebhook(request, slug, rpc) {
  if (request.method !== "POST") return Response.json({ ok: true, hint: "use POST" });
  const url = new URL(request.url);
  const secret = url.searchParams.get("token") || request.headers.get("x-webhook-token") || "";

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const items = Array.isArray(payload) ? payload.slice(0, 500) : [payload];
  const results = [];
  for (const p of items) {
    try {
      results.push(await rpc("ingest_zapi", { p_slug: slug, p_secret: secret, p }));
    } catch (e) {
      console.error("[zapi] erro", slug, e.message);
      return Response.json({ ok: false, error: "ingest_failed" }, { status: 500 });
    }
  }
  const first = results[0] || {};
  if (first.status === 401 || first.status === 404) {
    return Response.json({ ok: false, error: first.error }, { status: first.status });
  }
  return Response.json(items.length === 1 ? first : { ok: true, results });
}
