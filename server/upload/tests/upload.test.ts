import { expect, test } from "vitest";
import { createServer } from "node:http";
import { makeHandler, metadata } from "../src/handler.mjs";
import { s3Config } from "../src/node/s3.mjs";
import { readTicket, ticket } from "../src/tickets.mjs";
const secret = "x".repeat(40),
  owner = "a".repeat(64);
test("upload receipts reject tampering and expiration", () => {
  const signed = ticket({ owner, expires: Date.now() + 1000 }, secret);
  expect(readTicket(signed, secret).owner).toBe(owner);
  expect(() => readTicket(signed + "x", secret)).toThrow();
  expect(() => readTicket(ticket({ expires: 0 }, secret), secret)).toThrow();
});
test("upload metadata rejects oversized, nonvideo and invalid duration", () => {
  const body = {
    name: "clip.mov",
    type: "video/quicktime",
    size: 100,
    title: "Scene",
    durationSec: 30,
  };
  expect(metadata(body, owner, "https://assets.test").sourceUrl).toContain(`/videos/${owner}/`);
  expect(() => metadata({ ...body, size: 3 * 1024 ** 3 }, owner, "")).toThrow();
  expect(() => metadata({ ...body, type: "text/plain" }, owner, "")).toThrow();
  expect(() => metadata({ ...body, durationSec: NaN }, owner, "")).toThrow();
  const browserClip = metadata({ ...body, name: "simulation.webm", type: "video/webm" }, owner, "https://assets.test");
  expect(browserClip.sourceUrl).toMatch(/\.webm$/);
  expect(browserClip.type).toBe("video/webm");
});
test("presign/complete requires identity, matching object and creates memory only after upload", async () => {
  let saved: any,
    stored: any = { size: 0, type: "video/mp4" };
  const server = createServer(
    makeHandler({
      secret,
      assetBase: "https://assets.test",
      allowedOrigins: ["https://app.test"],
      pipelineIdentity: "b".repeat(64),
      verify: async (id: string, auth: string) => id === owner && auth === "Bearer valid",
      sign: async () => "https://storage.test/signed-put",
      head: async () => stored,
      createMemory: async (data: any) => {
        saved = data;
      },
      registerIdentity: async () => ({ identity: owner, token: "valid" }),
      listMemories: async (id: string) =>
        saved && id === owner ? [{ id: "42", requestId: saved.requestId, status: "uploaded" }] : [],
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const request = (path: string, body: any, token = "valid", origin = "https://app.test") =>
    fetch(`http://127.0.0.1:${port}/api/uploads/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identity: owner, ...body }),
    });
  try {
    const base = `http://127.0.0.1:${port}`;
    expect(
      (
        await fetch(`${base}/api/identity`, {
          method: "POST",
          headers: { Origin: "https://attacker.test" },
        })
      ).status,
    ).toBe(403);
    expect(await (await fetch(`${base}/api/identity`, { method: "POST" })).json()).toEqual({
      identity: owner,
      token: "valid",
    });
    expect((await fetch(`${base}/api/memories?identity=${owner}`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/memories?identity=${"b".repeat(64)}`, {
          headers: { Authorization: "Bearer valid" },
        })
      ).status,
    ).toBe(401);
    const input = {
      name: "clip.mp4",
      type: "video/mp4",
      size: 100,
      title: "Test",
      durationSec: 5,
    };
    expect((await request("presign", input, "invalid")).status).toBe(401);
    expect((await request("presign", input, "valid", "https://attacker.test")).status).toBe(403);
    const prepared = await (await request("presign", input)).json();
    expect(prepared.putUrl).toBe("https://storage.test/signed-put");
    expect((await request("complete", { receipt: prepared.receipt })).status).toBe(400);
    expect(saved).toBeUndefined();
    stored = { size: 100, type: "video/mp4" };
    expect((await request("complete", { receipt: prepared.receipt })).status).toBe(200);
    expect(saved.requestId).toBe(prepared.requestId);
    const listing = await fetch(`${base}/api/memories?identity=${owner}`, {
      headers: { Authorization: "Bearer valid" },
    });
    expect(await listing.json()).toEqual({
      memories: [{ id: "42", requestId: prepared.requestId, status: "uploaded" }],
    });
    expect((await request("complete", { receipt: prepared.receipt })).status).toBe(200);
    expect(saved.requestId).toBe(prepared.requestId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("real S3 presigner signs Content-Type and no empty-body checksum", async () => {
  const config = s3Config({
    S3_BUCKET: "test-bucket",
    S3_ENDPOINT: "https://storage.example.test",
    S3_REGION: "auto",
    ASSET_BASE_URL: "https://assets.test",
    UPLOAD_SIGNING_SECRET: secret,
    PIPELINE_IDENTITY: owner,
    STDB_HTTP_URL: "http://127.0.0.1:3055",
    STDB_DATABASE: "test",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
  });
  const url = new URL(
    await config.sign(
      metadata(
        {
          name: "clip.mp4",
          type: "video/mp4",
          size: 100,
          title: "Test",
          durationSec: 5,
        },
        owner,
        "https://assets.test",
      ),
    ),
  );
  expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  expect([...url.searchParams.keys()].some((k) => k.toLowerCase().startsWith("x-amz-checksum-"))).toBe(false);
  // Content-Type is signed (the presigner skips it by default), so a PUT of another type
  // fails the signature check instead of landing at the public asset URL.
  expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
    expect.arrayContaining(["content-type", "content-length", "host"]),
  );
  // Signed as a header the browser sends, not moved into the query string.
  expect(url.searchParams.has("Content-Type")).toBe(false);
});

const worker = "b".repeat(64);
const clip = {
  name: "clip.mp4",
  type: "video/mp4",
  size: 100,
  title: "Test",
  durationSec: 5,
};
/** A makeHandler server with stub auth and storage; records each createMemory call. */
async function stubService(overrides: Record<string, unknown> = {}) {
  const created: { data: any; pipeline: string }[] = [];
  const server = createServer(
    makeHandler({
      secret,
      assetBase: "https://assets.test",
      allowedOrigins: [],
      pipelineIdentity: worker,
      verify: async (id: string, auth: string) =>
        (id === owner && auth === "Bearer valid") || (id === worker && auth === "Bearer worker"),
      sign: async () => "https://storage.test/signed-put",
      head: async () => ({ size: 100, type: "video/mp4" }),
      createMemory: async (data: any, _auth: string, pipeline: string) => {
        created.push({ data, pipeline });
      },
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (path: string, body: Record<string, unknown>, token = "valid", identity = owner) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identity, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    base,
    post,
    created,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("routes match the path, ignoring query strings", async () => {
  const service = await stubService();
  try {
    expect((await fetch(`${service.base}/api/health?probe=1`)).status).toBe(200);
    const prepared = await service.post("/api/uploads/presign?x=1", clip);
    expect(prepared.status).toBe(200);
    expect(
      (
        await service.post("/api/uploads/complete?x=1", {
          receipt: prepared.body.receipt,
        })
      ).status,
    ).toBe(200);
    expect(service.created).toHaveLength(1);
    expect((await service.post("/api/uploads/other?x=1", clip)).status).toBe(404);
  } finally {
    await service.close();
  }
});

test("pipeline:false keeps a test upload off the worker's queue", async () => {
  const service = await stubService();
  try {
    // Default: the row is assigned to the pipeline worker.
    const real = await service.post("/api/uploads/presign", clip);
    expect(real.body.pipeline).toBe(true);
    const done = await service.post("/api/uploads/complete", {
      receipt: real.body.receipt,
    });
    expect(done.body.pipeline).toBe(true);
    expect(service.created[0].pipeline).toBe(worker);
    // A test upload: assigned to its uploader, which the worker never takes.
    const test = await service.post("/api/uploads/presign", {
      ...clip,
      pipeline: false,
    });
    expect(test.status).toBe(200);
    expect(test.body.pipeline).toBe(false);
    const receipt = test.body.receipt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const completed = await service.post("/api/uploads/complete", {
        receipt,
      });
      expect(completed.status).toBe(200);
      expect(completed.body.pipeline).toBe(false);
    }
    // Retries assign the same identity, so create_memory stays idempotent.
    expect(service.created.slice(1).map((c) => c.pipeline)).toEqual([owner, owner]);
    // The flag lives in the signed receipt: editing it breaks the signature.
    const [payload, signature] = receipt.split(".");
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        pipeline: true,
      }),
    ).toString("base64url");
    expect(
      (
        await service.post("/api/uploads/complete", {
          receipt: `${edited}.${signature}`,
        })
      ).status,
    ).toBe(400);
    expect(service.created).toHaveLength(3);
    // Only booleans; and the worker itself can't make a test row (it would be its own job).
    const invalid = await service.post("/api/uploads/presign", {
      ...clip,
      pipeline: "no",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/pipeline/);
    expect((await service.post("/api/uploads/presign", { ...clip, pipeline: false }, "worker", worker)).status).toBe(
      400,
    );
  } finally {
    await service.close();
  }
});

test("completion rejects storage PUT tickets and hides system error details", async () => {
  const service = await stubService();
  try {
    const prepared = await service.post("/api/uploads/presign", clip);
    const data = readTicket(prepared.body.receipt, secret);
    const rejected = await service.post("/api/uploads/complete", {
      receipt: ticket({ ...data, kind: "put" }, secret),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("Invalid upload receipt");
    expect(service.created).toHaveLength(0);
  } finally {
    await service.close();
  }
  const leaking = await stubService({
    head: async () => {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, open '/Users/someone/data/uploads/videos/x.mp4.json'"),
        { code: "ENOENT" },
      );
    },
  });
  const quiet = console.error;
  console.error = () => {}; // The service logs the full error on the server.
  try {
    const prepared = await leaking.post("/api/uploads/presign", clip);
    const failed = await leaking.post("/api/uploads/complete", {
      receipt: prepared.body.receipt,
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toBe("Upload failed; retry");
  } finally {
    console.error = quiet;
    await leaking.close();
  }
});

test("S3 completion before the PUT reports a missing upload", async () => {
  const storage = createServer((req, res) => {
    res.writeHead(req.method === "HEAD" ? 404 : 400);
    res.end();
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  try {
    const config = s3Config({
      S3_BUCKET: "test-bucket",
      S3_ENDPOINT: `http://127.0.0.1:${(storage.address() as any).port}`,
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      ASSET_BASE_URL: "https://assets.test",
      UPLOAD_SIGNING_SECRET: secret,
      PIPELINE_IDENTITY: owner,
      STDB_HTTP_URL: "http://127.0.0.1:3055",
      STDB_DATABASE: "test",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
    });
    await expect(config.head("videos/missing.mp4")).rejects.toThrow("Upload not found; PUT the video first");
  } finally {
    await new Promise<void>((resolve) => storage.close(() => resolve()));
  }
});

test("deployment config rejects unsafe asset URLs and trims browser origins", () => {
  const env = {
    S3_BUCKET: "test-bucket",
    ASSET_BASE_URL: "https://assets.example",
    UPLOAD_SIGNING_SECRET: secret,
    PIPELINE_IDENTITY: owner,
    STDB_HTTP_URL: "https://maincloud.example",
    STDB_DATABASE: "memos",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    UPLOAD_ALLOWED_ORIGINS: " https://memos.example , ",
  };
  expect(s3Config(env).allowedOrigins).toEqual(["https://memos.example"]);
  expect(s3Config(env).accountConfig).toEqual({ server: "https://maincloud.example", database: "memos" });
  for (const url of ["file:///tmp/videos", "https://user:password@assets.example", "https://assets.example?secret=x"])
    expect(() => s3Config({ ...env, ASSET_BASE_URL: url })).toThrow();
  expect(() => s3Config({ ...env, S3_ENDPOINT: "ftp://storage.example" })).toThrow();
});

test("profile API binds names to a verified token and rejects another user's ID", async () => {
  let displayName = "";
  const server = createServer(
    makeHandler({
      allowedOrigins: [],
      verify: async (id: string, auth: string) => id === owner && auth === "Bearer valid",
      getProfile: async (id: string) => ({ identity: id, displayName }),
      setProfile: async (name: string, auth: string) => {
        expect(auth).toBe("Bearer valid");
        displayName = name;
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/profile`;
  const post = (identity: string, name: string) =>
    fetch(base, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({ identity, displayName: name }),
    });
  try {
    expect((await fetch(base + `?identity=${owner}`)).status).toBe(401);
    expect((await post("b".repeat(64), "Stolen")).status).toBe(401);
    expect((await post(owner, " ")).status).toBe(400);
    expect((await post(owner, "a".repeat(41))).status).toBe(400);
    const response = await post(owner, "  Nikko  ");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity: owner, displayName: "Nikko" });
    expect(
      await (await fetch(base + `?identity=${owner}`, { headers: { Authorization: "Bearer valid" } })).json(),
    ).toEqual({ identity: owner, displayName: "Nikko" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
