/**
 * The upload API's Node entry point, for `npm run upload:local` (local disk), `npm run upload:dev` (S3/R2 with
 * server/upload/.env), `npm run upload:start` and the Docker image. TLS terminates at the platform or reverse proxy.
 *
 *   UPLOAD_STORAGE      s3 (default) or local
 *   UPLOAD_HOST         listen address; 127.0.0.1 unless NODE_ENV=production, which listens on 0.0.0.0
 *   PORT, UPLOAD_PORT   default 8788
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { makeHandler } from "../handler.mjs";

const storage = process.env.UPLOAD_STORAGE || "s3";
if (!["s3", "local"].includes(storage)) throw new Error("UPLOAD_STORAGE must be s3 or local");
const port = Number(process.env.PORT || process.env.UPLOAD_PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535");
// Load only the selected storage: S3 needs the AWS SDK, local disk needs node:sqlite.
const handler =
  storage === "s3"
    ? makeHandler((await import("./s3.mjs")).s3Config())
    : await (await import("./local.mjs")).createLocalHandler();
const host = process.env.UPLOAD_HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const server = createServer((req, res) => {
  void Promise.resolve(handler(req, res)).catch(() => {
    // Never log tokens, request bodies, signed URLs, or provider error payloads.
    console.error("Upload API request failed unexpectedly");
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Upload service unavailable; retry" }));
  });
});
server.requestTimeout = storage === "local" ? 15 * 60 * 1000 : 30000;
server.headersTimeout = 15000;
server.listen(port, host, () => {
  console.log(`memos upload API listening on ${host}:${port} (${storage} storage)`);
  if (storage === "local")
    console.log(
      `Videos and the worker identity (.worker-identity.json) are in ${resolve(process.env.LOCAL_UPLOAD_DIR || "data/uploads")}; ` +
        "metadata is in SpacetimeDB. No GPU reconstruction is simulated.",
    );
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10000).unref();
  });
