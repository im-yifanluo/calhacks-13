/** Local disk transport for capture tests. Uses the real SpacetimeDB module. */
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  open,
  stat,
  unlink,
  link,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { databaseConfig, makeHandler, ticket, readTicket } from "./service.mjs";

const validKey = /^videos\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(mp4|mov)$/i;
export async function localStorage({ directory, secret, publicOrigin }) {
  await mkdir(directory, { recursive: true });
  const pathFor = (key) => {
    if (!validKey.test(key)) throw new Error("Invalid storage key");
    return join(directory, key);
  };
  const head = async (key) => {
    const file = pathFor(key);
    const data = JSON.parse(await readFile(file + ".json", "utf8"));
    const info = await stat(file);
    if (info.size !== data.size) throw new Error("Stored size mismatch");
    return data;
  };
  return {
    sign: async (data) =>
      `${publicOrigin}/api/local-upload?receipt=${encodeURIComponent(ticket({ ...data, expires: Date.now() + 900_000 }, secret))}`,
    head,
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const send = (code, message) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
        return true;
      };
      if (url.pathname === "/api/local-upload" && req.method === "PUT") {
        let temporary, handle;
        try {
          const data = readTicket(url.searchParams.get("receipt"), secret);
          const file = pathFor(data.key);
          if (
            req.headers["content-type"] !== data.type ||
            Number(req.headers["content-length"]) !== data.size
          )
            return send(400, "Video size/type does not match upload ticket");
          await mkdir(dirname(file), { recursive: true });
          temporary = file + "." + randomUUID() + ".part";
          handle = await open(temporary, "wx", 0o600);
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > data.size)
              throw new Error("Upload exceeds declared size");
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          await handle.close();
          handle = undefined;
          if (size !== data.size) throw new Error("Incomplete upload");
          const metadata = {
            size,
            type: data.type,
            sha256: hash.digest("hex"),
          };
          try {
            await link(temporary, file);
          } catch (error) {
            if (
              error.code !== "EEXIST" ||
              (await head(data.key)).sha256 !== metadata.sha256
            )
              throw error;
          }
          await writeFile(file + ".json", JSON.stringify(metadata), {
            mode: 0o600,
          });
          res.writeHead(200);
          res.end();
        } catch (error) {
          if (!res.headersSent) send(400, error.message);
          else res.destroy();
        } finally {
          await handle?.close();
          if (temporary) await unlink(temporary).catch(() => {});
        }
        return true;
      }
      if (
        url.pathname.startsWith("/api/local-media/") &&
        ["GET", "HEAD"].includes(req.method)
      ) {
        try {
          const key = decodeURIComponent(
            url.pathname.slice("/api/local-media/".length),
          );
          const file = pathFor(key),
            meta = await head(key);
          let start = 0,
            end = meta.size - 1,
            status = 200;
          if (req.headers.range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            if (!match) return send(416, "Unsupported range");
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), end) : end;
            if (start > end || start >= meta.size)
              return send(416, "Range outside file");
            status = 206;
          }
          const headers = {
            "Content-Type": meta.type,
            "Content-Length": end - start + 1,
            "Accept-Ranges": "bytes",
            "X-Content-SHA256": meta.sha256,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          };
          if (status === 206)
            headers["Content-Range"] = `bytes ${start}-${end}/${meta.size}`;
          res.writeHead(status, headers);
          if (req.method === "HEAD") res.end();
          else
            createReadStream(file, { start, end })
              .on("error", () => res.destroy())
              .pipe(res);
        } catch {
          if (!res.headersSent) send(404, "Video not found");
          else res.destroy();
        }
        return true;
      }
      return false;
    },
  };
}
export async function createLocalHandler(env = process.env) {
  const directory = resolve(env.LOCAL_UPLOAD_DIR || "data/uploads");
  await mkdir(directory, { recursive: true });
  const secretPath = join(directory, ".signing-secret");
  let secret;
  try {
    secret = await readFile(secretPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secret = randomBytes(32).toString("hex");
    await writeFile(secretPath, secret, { flag: "wx", mode: 0o600 });
  }
  const origin = new URL(env.PUBLIC_ORIGIN || "http://127.0.0.1:5173").origin;
  const db = databaseConfig({
    STDB_HTTP_URL: env.STDB_HTTP_URL || "http://127.0.0.1:3000",
    STDB_DATABASE: env.STDB_DATABASE || "memory-replay",
  });
  const workerPath = join(directory, ".worker-identity.json");
  let worker;
  try {
    worker = JSON.parse(await readFile(workerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    worker = await db.registerIdentity();
    await writeFile(workerPath, JSON.stringify(worker), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const storage = await localStorage({
    directory,
    secret,
    publicOrigin: origin,
  });
  const allowedOrigins = [
    origin,
    ...(env.UPLOAD_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
  ];
  const api = makeHandler({
    ...db,
    ...storage,
    secret,
    assetBase: origin + "/api/local-media",
    allowedOrigins,
    pipelineIdentity:
      env.PIPELINE_IDENTITY || worker.identity.replace(/^0x/, ""),
  });
  return async (req, res) => {
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      res.writeHead(403);
      res.end("Origin not allowed");
      return;
    }
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Content-SHA256,Content-Length",
    );
    if (!(await storage.handle(req, res))) await api(req, res);
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createServer(await createLocalHandler());
  server.requestTimeout = 15 * 60 * 1000;
  server.listen(
    Number(process.env.UPLOAD_PORT || 8788),
    process.env.UPLOAD_HOST || "127.0.0.1",
    () =>
      console.log(
        "Local capture storage ready. Video files: data/uploads; metadata: SpacetimeDB. No GPU reconstruction is simulated.",
      ),
  );
}
