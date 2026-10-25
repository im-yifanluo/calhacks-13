/** Deployment entrypoint. TLS terminates at the hosting platform/reverse proxy. */
import { createServer } from "node:http";
import { makeHandler, productionConfig } from "./service.mjs";
import { createLocalHandler } from "./local.mjs";

const storage = process.env.UPLOAD_STORAGE || "s3";
if (!["s3", "local"].includes(storage)) throw new Error("UPLOAD_STORAGE must be s3 or local");
const port = Number(process.env.PORT || process.env.UPLOAD_PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535");
const handler = storage === "s3" ? makeHandler(productionConfig()) : await createLocalHandler();
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
server.listen(port, process.env.UPLOAD_HOST || "0.0.0.0", () => console.log(`memos upload API listening on port ${port} (${storage} storage)`));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000).unref();
});
