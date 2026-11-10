import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://localhost:${process.env.API_PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // modo demo: encaminha RPC e webhooks para o servidor local (scripts/dev-server.mjs)
    proxy: { "/rest": api, "/api": api },
  },
});
