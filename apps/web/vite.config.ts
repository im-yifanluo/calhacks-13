import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { fileURLToPath } from "node:url";

// HTTPS (self-signed) by default, for opening the laptop's LAN IP from a headset or phone.
// LOCAL_HTTP=1 serves plain http on 127.0.0.1 only: right for the Quest over USB
// (`adb reverse tcp:5173 tcp:5173`; localhost counts as a secure context for WebXR)
// and for `cloudflared tunnel --url http://127.0.0.1:5173`, which adds its own https.
const localHttp = process.env.LOCAL_HTTP === "1";

// SpacetimeDB and the upload service are reached through this same origin (/stdb, /api), so
// the Quest over adb, phones on the LAN and tunnels need no extra ports and hit no mixed content.
// 127.0.0.1 (not localhost): the local servers listen on IPv4 only.
const stdbTarget = process.env.STDB_URL ?? `http://127.0.0.1:${process.env.STDB_PORT ?? "3055"}`;
const uploadTarget = process.env.UPLOAD_URL ?? `http://127.0.0.1:${process.env.UPLOAD_PORT ?? "8788"}`;

export default defineConfig({
  plugins: localHttp ? [] : [basicSsl()],
  server: {
    host: process.env.VITE_HOST || (localHttp ? "127.0.0.1" : true),
    port: Number(process.env.VITE_PORT ?? 5173),
    allowedHosts: [
      ".trycloudflare.com",
      ".ngrok-free.app",
      ...(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).hostname] : []),
    ],
    proxy: {
      "/stdb": { target: stdbTarget, ws: true, rewrite: (path) => path.replace(/^\/stdb/, "") },
      "/api": { target: uploadTarget },
    },
  },
  // `vite preview` inherits server.proxy, host, allowedHosts and https.
  build: {
    rollupOptions: {
      input: {
        // fileURLToPath, not URL.pathname: pathname stays percent-encoded ("CalHacks%2013") and breaks paths with spaces.
        viewer: fileURLToPath(new URL("./index.html", import.meta.url)),
        capture: fileURLToPath(new URL("./capture.html", import.meta.url)),
      },
    },
  },
  // If we adopt IWSDK (super-three), keep a single three instance so Spark binds to it.
  resolve: { dedupe: ["three"] },
});
