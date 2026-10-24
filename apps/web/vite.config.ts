import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// WebXR needs HTTPS on the Quest browser. basicSsl gives a self-signed cert for LAN testing;
// for phones/judges use `npm run tunnel` (cloudflared) to get a real https URL.
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true, port: 5173, allowedHosts: [".trycloudflare.com", ".ngrok-free.app"] },
  // If we adopt IWSDK (super-three), keep a single three instance so Spark binds to it.
  resolve: { dedupe: ["three"] },
});
