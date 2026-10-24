import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Quest over USB (`adb reverse tcp:5173 tcp:5173`) and tunnels work over plain http:
// localhost counts as a secure context for WebXR, and the tunnel adds its own https.
// Set HTTPS=1 (npm run dev:lan) only to open the laptop's LAN IP directly from a headset.
const https = process.env.HTTPS === "1";

// SpacetimeDB is reached through this same origin (/v1/...), so the Quest over adb, phones on LAN,
// and cloudflared tunnels all connect without extra ports or mixed-content errors.
// 127.0.0.1 (not localhost): the local server listens on IPv4 only.
const stdbProxy = { "/v1": { target: process.env.STDB_URL ?? "http://127.0.0.1:3055", ws: true } };

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: { host: true, port: 5173, allowedHosts: [".trycloudflare.com", ".ngrok-free.app"], proxy: stdbProxy },
  preview: { proxy: stdbProxy },
  // If we adopt IWSDK (super-three), keep a single three instance so Spark binds to it.
  resolve: { dedupe: ["three"] },
  build: { rollupOptions: { input: { main: "index.html", smoke: "smoke.html" } } },
});
