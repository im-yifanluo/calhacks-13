/** Build only distributable viewer assets. Never copies private apps/web/public/memories. */
import { build } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/deploy/build-hosted-web.mjs <hosting-checkout/public>");
process.env.VITE_STDB_URL = "wss://maincloud.spacetimedb.com";
process.env.VITE_STDB_DATABASE = "jerry-memory-replay-phone-20261024";
process.env.VITE_ASSET_ORIGIN_ALIASES = "https://jerry-memory-replay-phone.alightdell64.chatgpt.site";
process.env.VITE_UPLOAD_API = "https://memos.alightdell64.chatgpt.site";
process.env.LOCAL_HTTP = "1";
const outDir = resolve(destination);
await build({
  root: resolve("apps/web"),
  configFile: resolve("apps/web/vite.config.ts"),
  publicDir: false,
  build: { outDir, emptyOutDir: true },
});
for (const directory of ["demo", "mock"]) {
  await mkdir(outDir, { recursive: true });
  await cp(resolve("apps/web/public", directory), resolve(outDir, directory), { recursive: true });
}
// Native capture remains in the iPhone app. Web library upload/playback is available.
