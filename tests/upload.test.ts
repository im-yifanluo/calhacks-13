import { expect, test } from "vitest";
import { createServer } from "node:http";
import {
  makeHandler,
  ticket,
  readTicket,
  metadata,
  productionConfig,
} from "../server/upload/service.mjs";
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
  expect(metadata(body, owner, "https://assets.test").sourceUrl).toContain(
    `/videos/${owner}/`,
  );
  expect(() => metadata({ ...body, size: 3 * 1024 ** 3 }, owner, "")).toThrow();
  expect(() => metadata({ ...body, type: "text/plain" }, owner, "")).toThrow();
  expect(() => metadata({ ...body, durationSec: NaN }, owner, "")).toThrow();
  const browserClip = metadata(
    { ...body, name: "simulation.webm", type: "video/webm" },
    owner,
    "https://assets.test",
  );
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
      verify: async (id: string, auth: string) =>
        id === owner && auth === "Bearer valid",
      sign: async () => "https://storage.test/signed-put",
      head: async () => stored,
      createMemory: async (data: any) => {
        saved = data;
      },
      registerIdentity: async () => ({ identity: owner, token: "valid" }),
      listMemories: async (id: string) =>
        saved && id === owner
          ? [{ id: "42", requestId: saved.requestId, status: "uploaded" }]
          : [],
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const request = (
    path: string,
    body: any,
    token = "valid",
    origin = "https://app.test",
  ) =>
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
    expect(
      await (await fetch(`${base}/api/identity`, { method: "POST" })).json(),
    ).toEqual({ identity: owner, token: "valid" });
    expect((await fetch(`${base}/api/memories?identity=${owner}`)).status).toBe(
      401,
    );
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
    expect(
      (await request("presign", input, "valid", "https://attacker.test"))
        .status,
    ).toBe(403);
    const prepared = await (await request("presign", input)).json();
    expect(prepared.putUrl).toBe("https://storage.test/signed-put");
    expect(
      (await request("complete", { receipt: prepared.receipt })).status,
    ).toBe(400);
    expect(saved).toBeUndefined();
    stored = { size: 100, type: "video/mp4" };
    expect(
      (await request("complete", { receipt: prepared.receipt })).status,
    ).toBe(200);
    expect(saved.requestId).toBe(prepared.requestId);
    const listing = await fetch(`${base}/api/memories?identity=${owner}`, {
      headers: { Authorization: "Bearer valid" },
    });
    expect(await listing.json()).toEqual({
      memories: [
        { id: "42", requestId: prepared.requestId, status: "uploaded" },
      ],
    });
    expect(
      (await request("complete", { receipt: prepared.receipt })).status,
    ).toBe(200);
    expect(saved.requestId).toBe(prepared.requestId);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("real S3 presigner does not bind a later browser upload to an empty-body checksum", async () => {
  const config = productionConfig({
    S3_BUCKET: "test-bucket",
    S3_ENDPOINT: "https://storage.example.test",
    S3_REGION: "auto",
    ASSET_BASE_URL: "https://assets.test",
    UPLOAD_SIGNING_SECRET: secret,
    PIPELINE_IDENTITY: owner,
    STDB_HTTP_URL: "http://127.0.0.1:3000",
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
  expect(
    [...url.searchParams.keys()].some((k) =>
      k.toLowerCase().startsWith("x-amz-checksum-"),
    ),
  ).toBe(false);
});
