/**
 * Build the viewer for the hosted site with its public settings (apps/web/.env.hosted), into a hosting checkout.
 * Copies only the distributable public folders, never the local scenes in apps/web/public/memories.
 */
import { build } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/deploy/build-hosted-web.mjs <hosting-checkout/public>");
process.env.LOCAL_HTTP = "1"; // no self-signed dev certificate plugin
const outDir = resolve(destination);
await build({
  root: resolve("apps/web"),
  configFile: resolve("apps/web/vite.config.ts"),
  mode: "hosted",
  publicDir: false,
  build: { outDir, emptyOutDir: true },
});
for (const directory of ["demo", "mock"]) {
  await mkdir(outDir, { recursive: true });
  await cp(resolve("apps/web/public", directory), resolve(outDir, directory), { recursive: true });
}
// Native capture remains in the iPhone app. Web library upload/playback is available.
