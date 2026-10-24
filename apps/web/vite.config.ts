import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// WebXR needs HTTPS on the Quest browser. basicSsl gives a self-signed cert for LAN testing;
// for phones/judges use `npm run tunnel` (cloudflared) to get a real https URL.
export default defineConfig({
  plugins: process.env.LOCAL_HTTP === "1" ? [] : [basicSsl()],
  server: {
    host: process.env.LOCAL_HTTP === "1" ? "127.0.0.1" : true,
    port: 5173,
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app"],
    proxy: {
      "/stdb": {
        target: "http://127.0.0.1:3000",
        ws: true,
        rewrite: (path) => path.replace(/^\/stdb/, ""),
      },
      "/api": { target: "http://127.0.0.1:8788" },
    },
  },
  // If we adopt IWSDK (super-three), keep a single three instance so Spark binds to it.
  resolve: { dedupe: ["three"] },
});
