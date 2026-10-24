import { expect, test } from "vitest";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalHandler, localStorage } from "../server/upload/local.mjs";
import { ticket } from "../server/upload/service.mjs";
const secret = "local-test-secret".repeat(3);
const owner = "a".repeat(64),
  worker = "c".repeat(64);

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
/** No absolute server path: neither the storage directory nor any home/temp path. */
function expectNoPath(text: string, directory: string) {
  expect(text).not.toContain(directory);
  expect(text).not.toMatch(/\/(Users|var|private|tmp|home)\//);
}

test.each(["mp4", "webm"])(
  "local %s storage persists exact bytes, supports playback ranges and rejects invalid upload tickets",
  async (extension) => {
    const key = `videos/${owner}/00000000-0000-4000-8000-000000000001.${extension}`;
    const directory = await mkdtemp(join(tmpdir(), "memreplay-storage-"));
    const storage = await localStorage({
      directory,
      secret,
      publicOrigin: "http://localhost",
    });
    const server = await listen(async (req, res) => {
      if (!(await storage.handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
    const base = server.base;
    // PUT tickets carry kind:"put" (storage.sign adds it); the completion receipt does not.
    const receipt = {
      key,
      size: 4,
      type: `video/${extension}`,
      expires: Date.now() + 60000,
    };
    const data = { ...receipt, kind: "put" };
    const put = (value: string, body: number[]) =>
      fetch(`${base}/api/local-upload?receipt=${encodeURIComponent(value)}`, {
        method: "PUT",
        headers: { "Content-Type": data.type },
        body: new Uint8Array(body),
      });
    try {
      expect((await put(ticket(data, secret) + "x", [1, 2, 3, 4])).status).toBe(
        400,
      );
      // A completion receipt (valid for an hour) is not a PUT ticket.
      const asPut = await put(ticket(receipt, secret), [1, 2, 3, 4]);
      expect(asPut.status).toBe(400);
      expect((await asPut.json()).error).toMatch(/Invalid upload ticket/);
      expect((await put(ticket(data, secret), [1, 2])).status).toBe(400);
      expect((await put(ticket(data, secret), [1, 2, 3, 4])).status).toBe(200);
      const restarted = await localStorage({
        directory,
        secret,
        publicOrigin: base,
      });
      expect((await restarted.head(key)).size).toBe(4);
      const media = `${base}/api/local-media/${key}`;
      expect([
        ...new Uint8Array(await (await fetch(media)).arrayBuffer()),
      ]).toEqual([1, 2, 3, 4]);
      const range = await fetch(media, { headers: { Range: "bytes=1-2" } });
      expect(range.status).toBe(206);
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3]);
      expect(
        (await fetch(media, { method: "HEAD" })).headers.get(
          "x-content-sha256",
        ),
      ).toMatch(/^[a-f0-9]{64}$/);
      // Different bytes for a stored key: rejected, and the reply names no server path.
      const conflict = await put(ticket(data, secret), [9, 9, 9, 9]);
      expect(conflict.status).toBe(400);
      const conflictText = await conflict.text();
      expect(conflictText).toMatch(/already stored with different bytes/);
      expectNoPath(conflictText, directory);
      expect([
        ...new Uint8Array(await (await fetch(media)).arrayBuffer()),
      ]).toEqual([1, 2, 3, 4]);
      // Identical bytes again: accepted (a retried PUT).
      expect((await put(ticket(data, secret), [1, 2, 3, 4])).status).toBe(200);
      // A missing upload: generic text, not the fs error with its absolute path.
      const missing = key.replace("0001", "0002");
      const error = await restarted.head(missing).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Upload not found; PUT the video first",
      );
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("upload:local end to end against a stub SpacetimeDB: tickets, errors and test uploads", async () => {
  // A stub of the three SpacetimeDB HTTP calls the service makes.
  const rows: unknown[][] = [];
  const calls: unknown[][] = [];
  const stdb = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.url === `/v1/identity/${owner}/verify`) {
      res.writeHead(req.headers.authorization === "Bearer owner" ? 204 : 401);
      return res.end();
    }
    if (req.url === "/v1/database/memreplay-test/call/create_memory") {
      const args = JSON.parse(body);
      calls.push(args);
      const [requestId, title, sourceUrl, , [pipeline], durationUs] = args;
      if (!rows.some((row) => row[5] === requestId))
        rows.push([
          rows.length + 1,
          title,
          sourceUrl,
          "uploaded",
          durationUs,
          requestId,
          [pipeline],
        ]);
      res.writeHead(200);
      return res.end();
    }
    if (req.url === "/v1/database/memreplay-test/sql") {
      expect(body).toContain(`WHERE owner = 0x${owner}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{ schema: {}, rows }]));
    }
    res.writeHead(404);
    res.end();
  });
  const directory = await mkdtemp(join(tmpdir(), "memreplay-local-"));
  // An existing worker identity: nothing is minted at startup.
  await writeFile(
    join(directory, ".worker-identity.json"),
    JSON.stringify({ identity: worker, token: "worker-token" }),
  );
  let handler: RequestListener = () => {};
  const app = await listen((req, res) => handler(req, res));
  handler = await createLocalHandler({
    LOCAL_UPLOAD_DIR: directory,
    PUBLIC_ORIGIN: app.base,
    STDB_HTTP_URL: stdb.base,
    STDB_DATABASE: "memreplay-test",
  });
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(app.base + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
        Origin: app.base,
      },
      body: JSON.stringify({ identity: owner, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  const upload = async (pipeline?: boolean) => {
    const prepared = await post("/api/uploads/presign", {
      name: "clip.mov",
      type: "video/quicktime",
      size: 4,
      title: `Clip ${pipeline}`,
      durationSec: 2,
      ...(pipeline === undefined ? {} : { pipeline }),
    });
    expect(prepared.status).toBe(200);
    // Completing before the PUT: a clear message, no server path.
    const early = await post("/api/uploads/complete", {
      receipt: prepared.body.receipt,
    });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe("Upload not found; PUT the video first");
    expectNoPath(JSON.stringify(early.body), directory);
    // The completion receipt can't be used as the PUT ticket...
    const receiptAsPut = await fetch(
      `${app.base}/api/local-upload?receipt=${encodeURIComponent(prepared.body.receipt)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "video/quicktime" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(receiptAsPut.status).toBe(400);
    const stored = await fetch(prepared.body.putUrl, {
      method: "PUT",
      headers: prepared.body.headers,
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(stored.status).toBe(200);
    // ...and the PUT ticket can't complete the upload.
    const putTicket = new URL(prepared.body.putUrl).searchParams.get(
      "receipt",
    )!;
    expect(
      (await post("/api/uploads/complete", { receipt: putTicket })).status,
    ).toBe(400);
    const completed = await post("/api/uploads/complete", {
      receipt: prepared.body.receipt,
    });
    expect(completed.status).toBe(200);
    return { prepared: prepared.body, completed: completed.body };
  };
  try {
    const real = await upload();
    expect(real.prepared.pipeline).toBe(true);
    expect(real.completed.memory.pipelineIdentity).toBe(worker);
    const test = await upload(false);
    expect(test.prepared.pipeline).toBe(false);
    expect(test.completed.pipeline).toBe(false);
    expect(test.completed.memory.pipelineIdentity).toBe(owner);
    // The create_memory payloads: [requestId, title, sourceUrl, manifestUrl, [identity], µs].
    expect(calls.map((args) => args[4])).toEqual([
      [`0x${worker}`],
      [`0x${owner}`],
    ]);
    expect(calls[1][2]).toBe(
      `${app.base}/api/local-media/videos/${owner}/${test.prepared.requestId}.mov`,
    );
    expect(calls[1][5]).toBe(2_000_000);
    // The stored clip plays back from its source URL.
    const media = await fetch(test.prepared.sourceUrl);
    expect(media.headers.get("content-type")).toBe("video/quicktime");
    expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([
      1, 2, 3, 4,
    ]);
  } finally {
    await app.close();
    await stdb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload:local answers the cross-origin PUT preflight for allowed origins only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memreplay-cors-"));
  await writeFile(
    join(directory, ".worker-identity.json"),
    JSON.stringify({ identity: worker, token: "worker-token" }),
  );
  const app = await listen(
    await createLocalHandler({
      LOCAL_UPLOAD_DIR: directory,
      PUBLIC_ORIGIN: "http://app.test",
      STDB_HTTP_URL: "http://127.0.0.1:9", // never called
    }),
  );
  const preflight = (path: string, origin: string) =>
    fetch(app.base + path, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
  try {
    const allowed = await preflight(
      "/api/local-upload?receipt=x",
      "http://app.test",
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toBe(
      "PUT,OPTIONS",
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://app.test",
    );
    expect(
      allowed.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("content-type");
    expect(
      (await preflight("/api/local-upload", "https://attacker.test")).status,
    ).toBe(403);
    // The API routes keep their own methods.
    const api = await preflight("/api/uploads/presign", "http://app.test");
    expect(api.headers.get("access-control-allow-methods")).toBe(
      "POST,OPTIONS,GET",
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
