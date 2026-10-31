import { test, expect, vi, afterEach } from "vitest";
import { handleHostedRequest } from "../server/upload/worker.mjs";
import { sceneReferences } from "../server/upload/scene-import.mjs";
import { encodePersonalKey } from "../server/upload/accounts.mjs";
afterEach(() => vi.restoreAllMocks());
test("rendered bundles register only after references exist, preserve ownership, and reject cross-account receipts", async () => {
  const owner = "a".repeat(64),
    origin = "https://memos.example",
    requestId = "12345678-1234-1234-1234-123456789abc";
  const account = { server: "https://db.example", database: "memos", identity: owner, token: "aaa.bbb.ccc" };
  const objects = new Map<string, any>();
  let registered: any;
  const env = {
    PUBLIC_ORIGIN: origin,
    STDB_HTTP_URL: account.server,
    STDB_DATABASE: account.database,
    UPLOAD_SIGNING_SECRET: "s".repeat(64),
    BUCKET: {
      head: async (k: string) => objects.get(k),
      get: async (k: string) => objects.get(k),
      put: async (k: string, b: any, o: any) => {
        if (objects.has(k)) return null;
        const data = Buffer.from(await new Response(b).arrayBuffer());
        const value = {
          size: data.length,
          body: data,
          httpMetadata: o.httpMetadata,
          json: async () => JSON.parse(data.toString()),
        };
        objects.set(k, value);
        return value;
      },
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    if (String(url).endsWith("/call/create_memory")) {
      registered = JSON.parse(init.body);
      return new Response(null, { status: 200 });
    }
    if (String(url).endsWith("/sql"))
      return Response.json([
        { rows: [[10, "Room", "", "ready", "2000000", requestId, ["0x" + owner], registered[3], 1, ""]] },
      ]);
    return new Response(null, { status: 200 });
  });
  const call = async (path: string, input: any, identity = owner) =>
    handleHostedRequest(
      new Request(origin + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + encodePersonalKey({ ...account, identity }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      env,
    );
  const start = await (await call("/api/scenes/start", { requestId, title: "Room" }))!.json();
  expect((await call("/api/scenes/presign", { receipt: start.receipt, path: "../secret.json", size: 4 }))!.status).toBe(
    400,
  );
  expect(
    (await call("/api/scenes/presign", { receipt: start.receipt, path: "memory.json", size: 4 }, "b".repeat(64)))!
      .status,
  ).toBe(403);
  const upload = async (path: string, data: Buffer) => {
    const s = await (await call("/api/scenes/presign", { receipt: start.receipt, path, size: data.length }))!.json();
    return handleHostedRequest(
      new Request(s.putUrl, { method: "PUT", headers: { "Content-Length": String(data.length) }, body: data }),
      env,
    );
  };
  await upload(
    "memory.json",
    Buffer.from(JSON.stringify({ background: { url: "room.spz" }, timeline: { durationSec: 2 } })),
  );
  expect((await call("/api/scenes/complete", { receipt: start.receipt }))!.status).toBe(400);
  expect(registered).toBeUndefined();
  await upload("room.spz", Buffer.from("splats"));
  const done = await (await call("/api/scenes/complete", { receipt: start.receipt }))!.json();
  expect(done.memory.status).toBe("ready");
  expect(registered[2]).toBe("");
  expect(registered[4]).toEqual(["0x" + owner]);
  expect(done.manifestUrl).toContain("/media/imports/" + owner + "/" + requestId + "/memory.json");
  expect((await handleHostedRequest(new Request(done.manifestUrl, { method: "HEAD" }), env))!.status).toBe(200);
  expect((await call("/api/scenes/complete", { receipt: start.receipt }))!.status).toBe(200);
});
test("scene validation rejects external references, traversal and unbounded sequences", () => {
  const manifest = { background: { url: "room.spz" }, timeline: { durationSec: 2 } };
  expect(() => sceneReferences({ ...manifest, camera: { url: "https://evil.example/secret" } })).toThrow();
  expect(() => sceneReferences({ ...manifest, camera: { url: "../secret.json" } })).toThrow();
  expect(() =>
    sceneReferences({
      ...manifest,
      objects: [{ kind: "splat-sequence", frameCount: 999999, urlPattern: "frame{frame}.spz" }],
    }),
  ).toThrow();
});
