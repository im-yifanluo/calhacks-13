// Start both web-facing services with the same database/origin. SpacetimeDB runs separately.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const lan = process.argv.includes("--lan") || process.env.PARTY_LAN === "1";
const https = process.env.PARTY_HTTPS === "1";
const port = process.env.VITE_PORT || "5173";
const address = lan
  ? Object.values(networkInterfaces())
      .flat()
      .find(
        (entry) =>
          entry &&
          !entry.internal &&
          entry.family === "IPv4" &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
      )?.address
  : undefined;
if (lan && !address && !process.env.PUBLIC_ORIGIN) {
  console.error(
    "No local network address found. Connect to Wi-Fi or set PUBLIC_ORIGIN to this Mac's reachable address.",
  );
  process.exit(1);
}
const origin = process.env.PUBLIC_ORIGIN || `${https ? "https" : "http"}://${address || "127.0.0.1"}:${port}`;
const database = process.env.STDB_DATABASE || "memory-replay-party";
const env = {
  ...process.env,
  STDB_DATABASE: database,
  VITE_STDB_DATABASE: database,
  STDB_PORT: process.env.STDB_PORT || "3055",
  PUBLIC_ORIGIN: origin,
  ACCOUNT_SERVER_URL:
    process.env.ACCOUNT_SERVER_URL ||
    process.env.STDB_PUBLIC_URL ||
    (process.env.VITE_STDB_URL
      ? process.env.VITE_STDB_URL.replace(/^ws/, "http").replace(/\/$/, "")
      : `${origin}/stdb`),
  LOCAL_HTTP: https ? "0" : "1",
  VITE_PORT: port,
  ...(lan ? { VITE_HOST: "0.0.0.0" } : {}),
};
console.log(
  `Party demo: ${origin}\nDatabase: ${database} on port ${env.STDB_PORT}\nPublish the current module before joining. Six-digit passwords use the upload service; see docs/PARTIES.md.`,
);
if (lan)
  console.log(
    "Open this same address on the Mac and iPhone using the same Wi-Fi. Keep the Mac awake. Guest parties work over HTTP; account sign-in, camera capture and immersive VR need trusted HTTPS.",
  );
const children = [
  spawn(process.execPath, ["server/upload/local.mjs"], {
    cwd: root,
    env,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--strictPort"],
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
