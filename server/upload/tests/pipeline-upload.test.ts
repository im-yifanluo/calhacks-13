import { afterEach, expect, test, vi } from "vitest";
import { handleHostedRequest } from "../worker.mjs";
import { SCENE_PART_BYTES } from "../pipeline.mjs";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const objects = new Map<string, any>(),
    uploads = new Map<string, any>();
  const worker = "b".repeat(64),
    owner = "a".repeat(64),
    origin = "https://memos.example";
  let status = "processing";
  const bucket = {
    head: async (key: string) => objects.get(key) ?? null,
    get: async (key: string, options?: any) => {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: options?.range
          ? obj.body.subarray(options.range.offset, options.range.offset + options.range.length)
          : obj.body,
      };
    },
    async createMultipartUpload(key: string, meta: any) {
      const uploadId = String(uploads.size + 1);
      uploads.set(uploadId, { key, meta, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key: string, id: string) {
      const upload = uploads.get(id);
      return {
        async uploadPart(n: number, stream: ReadableStream) {
          const data = Buffer.from(await new Response(stream).arrayBuffer());
          upload.parts.set(n, data);
          return { partNumber: n, etag: `etag-${n}` };
        },
        async complete(parts: any[]) {
          const body = Buffer.concat(parts.map((p) => upload.parts.get(p.partNumber)));
          const object = { body, size: body.length, ...upload.meta, httpEtag: '"complete"' };
          objects.set(key, object);
          uploads.delete(id);
          return object;
        },
        async abort() {
          uploads.delete(id);
        },
      };
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/verify"))
      return new Response(null, { status: (init?.headers as any).Authorization === "Bearer worker-token" ? 200 : 401 });
    return Response.json([
      { rows: [[["0x" + worker], ["0x" + owner], "00000000-0000-4000-8000-000000000001", status]] },
    ]);
  });
  const env = {
    BUCKET: bucket,
    PUBLIC_ORIGIN: origin,
    STDB_HTTP_URL: "https://db.example",
    STDB_DATABASE: "memos",
    PIPELINE_IDENTITY: worker,
    UPLOAD_SIGNING_SECRET: "s".repeat(64),
  };
  const call = (path: string, body?: any, token = "worker-token") =>
    handleHostedRequest(
      new Request(origin + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer " + token },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    ) as Promise<Response>;
  const part = (ticket: string, part: number, bytes: Uint8Array) =>
    handleHostedRequest(
      new Request(`${origin}/api/pipeline/assets/part?ticket=${encodeURIComponent(ticket)}&part=${part}`, {
        method: "PUT",
        headers: { Authorization: "Bearer worker-token", "Content-Length": String(bytes.length) },
        body: bytes as any,
      }),
      env,
    ) as Promise<Response>;
  return {
    call,
    part,
    env,
    objects,
    uploads,
    setStatus: (s: string) => {
      status = s;
    },
  };
}

test("only the assigned verified worker can publish processing memories, using safe paths", async () => {
  const f = fixture(),
    input = { memoryId: "6", path: "background/room.spz", size: 5 };
  expect((await f.call("/api/pipeline/config", undefined, "user-token")).status).toBe(401);
  expect((await f.call("/api/pipeline/assets/start", input, "user-token")).status).toBe(401);
  for (const path of ["../secret.json", "/file.json", "x/../../a.json", "room.html", "https://evil/a.spz"])
    expect((await f.call("/api/pipeline/assets/start", { ...input, path })).status).toBe(400);
  f.setStatus("ready");
  expect((await f.call("/api/pipeline/assets/start", input)).status).toBe(409);
  f.env.PIPELINE_IDENTITY = "";
  expect((await f.call("/api/pipeline/config")).status).toBe(503);
  expect(f.uploads.size).toBe(0);
});

test("multipart assets stream, complete idempotently, and load with browser range requests", async () => {
  const f = fixture(),
    data = Buffer.alloc(SCENE_PART_BYTES + 7, 37);
  const start = await (
    await f.call("/api/pipeline/assets/start", { memoryId: "6", path: "background/room.spz", size: data.length })
  ).json();
  expect(start.partCount).toBe(2);
  expect((await f.part(start.ticket + "x", 1, data.subarray(0, SCENE_PART_BYTES))).status).toBe(401);
  expect((await f.part(start.ticket, 1, Buffer.from("short"))).status).toBe(400);
  const parts = [
    await (await f.part(start.ticket, 1, data.subarray(0, SCENE_PART_BYTES))).json(),
    await (await f.part(start.ticket, 2, data.subarray(SCENE_PART_BYTES))).json(),
  ];
  expect((await f.call("/api/pipeline/assets/complete", { ticket: start.ticket, parts: parts.slice(1) })).status).toBe(
    400,
  );
  for (let i = 0; i < 2; i++)
    expect((await f.call("/api/pipeline/assets/complete", { ticket: start.ticket, parts })).status).toBe(200);
  const media = await handleHostedRequest(
    new Request(start.assetUrl, { headers: { Range: `bytes=${SCENE_PART_BYTES}-` } }),
    f.env,
  );
  expect(media!.status).toBe(206);
  expect(Buffer.from(await media!.arrayBuffer())).toEqual(data.subarray(SCENE_PART_BYTES));
  expect(f.uploads.size).toBe(0);
});

test("abandoned uploads can be aborted and publishing does not set a memory ready", async () => {
  const f = fixture();
  const start = await (
    await f.call("/api/pipeline/assets/start", { memoryId: "6", path: "memory.json", size: 2 })
  ).json();
  expect((await f.call("/api/pipeline/assets/abort", { ticket: start.ticket })).status).toBe(200);
  expect(f.uploads.size).toBe(0);
  expect(f.objects.size).toBe(0);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("/call/"))).toBe(true);
});
