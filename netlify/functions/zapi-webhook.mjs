import { handleZapiWebhook } from "../lib/webhook.mjs";
import { adminRpc } from "../lib/supabase.mjs";

export default async (request, context) => handleZapiWebhook(request, context.params.slug, adminRpc);

export const config = { path: "/api/zapi/:slug" };
