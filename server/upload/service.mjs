import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function ticket(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
export function readTicket(value, secret) {
  const [data, sig] = String(value).split(".");
  const expected = createHmac("sha256", secret)
    .update(data ?? "")
    .digest();
  const received = Buffer.from(sig ?? "", "base64url");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw new Error("Invalid upload receipt");
  const payload = JSON.parse(Buffer.from(data, "base64url").toString());
  if (payload.expires < Date.now())
    throw new Error("Upload receipt expired; request a new upload");
  return payload;
}
/**
 * Validates a presign request. `pipeline: false` marks a test upload (capture simulation,
 * test-video): its memory row is assigned to the uploader instead of the pipeline worker,
 * and the worker only takes `uploaded` rows assigned to its own identity.
 */
export function metadata(body, owner, base) {
  const { name, type, size, title, durationSec, pipeline = true } = body;
  if (typeof name !== "string" || !/^.+\.(mp4|mov|webm)$/i.test(name))
    throw new Error("Select an MP4, MOV or WebM");
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(type))
    throw new Error("Unsupported video type");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3)
    throw new Error("Video must be 1 byte to 2 GiB");
  if (typeof title !== "string" || !title.trim() || title.length > 120)
    throw new Error("Title must be 1–120 characters");
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600)
    throw new Error("Video duration must be 0–3600 seconds");
  if (typeof pipeline !== "boolean")
    throw new Error("pipeline must be true or false");
  const requestId = randomUUID();
  const extension = name.toLowerCase().split(".").pop();
  const key = `videos/${owner}/${requestId}.${extension}`;
  return {
    owner,
    requestId,
    key,
    type,
    size,
    title: title.trim(),
    durationUs: Math.round(durationSec * 1e6),
    sourceUrl: `${base.replace(/\/$/, "")}/${key}`,
    pipeline,
    expires: Date.now() + 3600_000,
  };
}
/** Node system errors (ENOENT, ECONNREFUSED…) can name absolute paths on this machine. */
const systemError = (error) =>
  typeof error?.code === "string" && /^E[A-Z0-9_]+$/.test(error.code);
async function json(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16000) throw new Error("Request too large");
  }
  return JSON.parse(text);
}
export function makeHandler({
  secret,
  assetBase,
  allowedOrigins,
  verify,
  sign,
  head,
  createMemory,
  pipelineIdentity,
  registerIdentity,
  listMemories,
}) {
  return async (req, res) => {
    const origin = req.headers.origin;
    const route = new URL(req.url, "http://localhost");
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    if (origin && !allowedOrigins.includes(origin))
      return send(403, { error: "Origin not allowed" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (route.pathname === "/api/health") return send(200, { status: "ok" });
    if (
      req.method === "POST" &&
      route.pathname === "/api/identity" &&
      registerIdentity
    ) {
      try {
        return send(200, await registerIdentity());
      } catch {
        return send(502, { error: "Could not connect to SpacetimeDB" });
      }
    }
    const listing =
      req.method === "GET" &&
      route.pathname === "/api/memories" &&
      listMemories;
    if (
      !listing &&
      (req.method !== "POST" ||
        !["/api/uploads/presign", "/api/uploads/complete"].includes(
          route.pathname,
        ))
    )
      return send(404, { error: "Not found" });
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
      return send(401, { error: "Connect to SpacetimeDB first" });
    try {
      const body = listing
        ? { identity: route.searchParams.get("identity") }
        : await json(req);
      if (!/^[a-f0-9]{64}$/i.test(body.identity ?? ""))
        return send(401, { error: "Invalid identity" });
      if (!(await verify(body.identity, auth)))
        return send(401, { error: "Identity/token mismatch" });
      if (listing)
        return send(200, { memories: await listMemories(body.identity, auth) });
      if (route.pathname === "/api/uploads/presign") {
        const data = metadata(body, body.identity, assetBase);
        // A test row is assigned to its uploader; for the worker itself that is its queue.
        if (
          !data.pipeline &&
          data.owner.toLowerCase() === String(pipelineIdentity).toLowerCase()
        )
          throw new Error(
            "The pipeline worker's identity cannot make test uploads",
          );
        return send(200, {
          putUrl: await sign(data),
          receipt: ticket(data, secret),
          requestId: data.requestId,
          sourceUrl: data.sourceUrl,
          headers: { "Content-Type": data.type },
          pipeline: data.pipeline,
          expiresIn: 900,
          receiptExpiresAt: data.expires,
        });
      }
      const data = readTicket(body.receipt, secret);
      // Storage tickets (upload:local's PUT URLs) carry a kind; only receipts complete.
      if (data.kind) throw new Error("Invalid upload receipt");
      if (data.owner !== body.identity)
        return send(403, { error: "Receipt belongs to another identity" });
      const stored = await head(data.key);
      if (stored.size !== data.size || stored.type !== data.type)
        throw new Error(
          "Upload is incomplete or has incorrect content type/size",
        );
      // The flag is inside the signed receipt, so a retry assigns the same identity
      // (create_memory rejects a repeated request ID with a different one).
      const queued = data.pipeline !== false;
      await createMemory(data, auth, queued ? pipelineIdentity : data.owner);
      const memory = listMemories
        ? (await listMemories(data.owner, auth)).find(
            (row) => row.requestId === data.requestId,
          )
        : undefined;
      if (listMemories && !memory)
        throw new Error(
          "Upload stored, but database confirmation is missing. Retry completion.",
        );
      return send(200, {
        requestId: data.requestId,
        status: memory?.status || "uploaded",
        pipeline: queued,
        memory,
      });
    } catch (error) {
      if (systemError(error)) console.error("Upload request failed:", error);
      send(400, {
        error:
          error instanceof Error && !systemError(error)
            ? error.message
            : "Upload failed; retry",
      });
    }
  };
}
export function productionConfig(env = process.env) {
  for (const name of [
    "S3_BUCKET",
    "ASSET_BASE_URL",
    "UPLOAD_SIGNING_SECRET",
    "PIPELINE_IDENTITY",
    "STDB_HTTP_URL",
    "STDB_DATABASE",
  ])
    if (!env[name]) throw new Error(`${name} is required`);
  if (env.UPLOAD_SIGNING_SECRET.length < 32)
    throw new Error("UPLOAD_SIGNING_SECRET needs 32+ characters");
  if (!/^[a-f0-9]{64}$/i.test(env.PIPELINE_IDENTITY))
    throw new Error("PIPELINE_IDENTITY must be a 64-character hex identity");
  const s3 = new S3Client({
    // The browser supplies the body later. Do not sign a checksum of an empty body.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            sessionToken: env.AWS_SESSION_TOKEN,
          }
        : undefined,
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION || "auto",
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  });
  return {
    secret: env.UPLOAD_SIGNING_SECRET,
    assetBase: env.ASSET_BASE_URL,
    pipelineIdentity: env.PIPELINE_IDENTITY,
    allowedOrigins: (
      env.UPLOAD_ALLOWED_ORIGINS || "https://localhost:5173"
    ).split(","),
    ...databaseConfig(env),
    sign: async (d) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: d.key,
          ContentType: d.type,
          ContentLength: d.size,
        }),
        // The presigner leaves Content-Type unsigned by default. Signed, storage refuses a
        // PUT of any other type to this key, which is later served at a public URL.
        { expiresIn: 900, signableHeaders: new Set(["content-type"]) },
      ),
    head: async (key) => {
      try {
        const result = await s3.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
        );
        return { size: result.ContentLength, type: result.ContentType };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404)
          throw new Error("Upload not found; PUT the video first");
        throw error;
      }
    },
  };
}

export function databaseConfig(env = process.env) {
  const base = env.STDB_HTTP_URL.replace(/\/$/, "");
  const url = `${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}`;
  return {
    verify: async (id, auth) =>
      (
        await fetch(`${base}/v1/identity/${id}/verify`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(10000),
        })
      ).ok,
    registerIdentity: async () => {
      const response = await fetch(`${base}/v1/identity`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Identity registration failed");
      return response.json();
    },
    listMemories: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/i.test(identity))
        throw new Error("Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { Authorization: auth },
        body: `SELECT id, title, source_url, status, duration_us, request_id, pipeline_identity FROM memory WHERE owner = 0x${identity}`,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Database lookup failed");
      const [result] = await response.json();
      // SQL returns an identity as ["0x<64 hex>"]; report it like the API's identities.
      const hex = (value) =>
        String(Array.isArray(value) ? value[0] : value)
          .replace(/^0x/, "")
          .toLowerCase();
      return result.rows.map(
        ([
          id,
          title,
          sourceUrl,
          status,
          durationUs,
          requestId,
          pipelineIdentity,
        ]) => ({
          id: String(id),
          title,
          sourceUrl,
          status,
          durationUs: String(durationUs),
          requestId,
          pipelineIdentity: hex(pipelineIdentity),
        }),
      );
    },
    createMemory: async (d, auth, pipeline) => {
      const response = await fetch(
        `${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}/call/create_memory`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify([
            d.requestId,
            d.title,
            d.sourceUrl,
            "",
            ["0x" + pipeline],
            d.durationUs,
          ]),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new Error(
          `createMemory failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createServer(makeHandler(productionConfig()));
  server.requestTimeout = 30000;
  server.listen(
    Number(process.env.UPLOAD_PORT || 8788),
    process.env.UPLOAD_HOST || "127.0.0.1",
    () => console.log("Upload signing service ready"),
  );
}
