// Start both web-facing services with the same database/origin. SpacetimeDB runs separately.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const https = process.env.PARTY_HTTPS === "1";
const port = process.env.VITE_PORT || "5173";
const origin =
  process.env.PUBLIC_ORIGIN ||
  `${https ? "https" : "http"}://127.0.0.1:${port}`;
const database = process.env.STDB_DATABASE || "memory-replay-party";
const env = {
  ...process.env,
  STDB_DATABASE: database,
  VITE_STDB_DATABASE: database,
  STDB_PORT: process.env.STDB_PORT || "3055",
  PUBLIC_ORIGIN: origin,
  LOCAL_HTTP: https ? "0" : "1",
  VITE_PORT: port,
};
console.log(
  `Party demo: ${origin}\nDatabase: ${database} on port ${env.STDB_PORT}\nPublish the current module before joining. Google is optional; see docs/PARTIES.md.`,
);
const children = [
  spawn(process.execPath, ["server/upload/local.mjs"], {
    cwd: root,
    env,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/vite/bin/vite.js", import.meta.url),
      ),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
      env,
      stdio: "inherit",
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
