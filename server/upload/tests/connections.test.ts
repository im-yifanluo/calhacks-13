import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionConfig } from "../connections.mjs";
import { sceneStorage } from "../scenes.mjs";
import { makeHandler } from "../service.mjs";

const owner = "a".repeat(64),
  worker = "b".repeat(64);
const env = { STDB_HTTP_URL: "https://db.test/stdb/", STDB_DATABASE: "test", PIPELINE_IDENTITY: worker };
afterEach(() => vi.unstubAllGlobals());
test("connection discovery checks actual schema reads and distinguishes configuration from transfers", async () => {
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Authorization: "Bearer test" });
    expect(String(options.body)).toMatch(/^SELECT /);
    return Response.json([{ rows: [] }]);
  });
  vi.stubGlobal("fetch", fetch);
  const report = await connectionConfig(env, { backend: "s3", assetBaseUrl: "https://assets.test" })("Bearer test");
  expect(report.status).toBe("reachable");
  expect(report.database.checks).toHaveLength(9);
  expect(report.interfaces.I3.reducer).toBe("https://db.test/stdb/v1/database/test/call/create_memory");
  expect(report.interfaces.I4.pendingQuery).toContain(`pipeline_identity = 0x${worker}`);
  expect(report.interfaces.I4.workerRunning).toBe("not_checked");
  expect(report.interfaces.I5.transferVerified).toBe(false);
  expect(report.interfaces.I7.websocketUrl).toBe("wss://db.test/stdb/");
  expect(report.interfaces.I7.websocketVerified).toBe(false);
  expect(JSON.stringify(report)).not.toContain("Bearer test");
});
test("missing tables, invalid SQL results and network errors fail readiness without exposing provider errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      const query = String(options.body);
      if (query.includes("FROM memory")) return new Response("secret provider detail", { status: 404 });
      if (query.includes("FROM player")) throw new Error("/private/secret server path");
      if (query.includes("FROM room")) return Response.json({ rows: [] });
      return Response.json([{ rows: [] }]);
    }),
  );
  const report = await connectionConfig(env, { backend: "local" })("Bearer test");
  expect(report.status).toBe("unavailable");
  expect(report.interfaces.I3.status).toBe("unavailable");
  expect(report.interfaces.I7.status).toBe("unavailable");
  expect(JSON.stringify(report)).not.toMatch(/secret|private/);
});
test("connection settings reject malformed destinations and worker identities", () => {
  for (const STDB_HTTP_URL of ["ftp://db.test", "https://user:password@db.test", "https://db.test/?key=secret"])
    expect(() => connectionConfig({ ...env, STDB_HTTP_URL }, {})).toThrow();
  expect(() => connectionConfig({ ...env, PIPELINE_IDENTITY: "invalid" }, {})).toThrow(/PIPELINE_IDENTITY/);
});
test("connection API requires matching identity and reports database unavailability as 503", async () => {
  let calls = 0;
  const server = createServer(
    makeHandler({
      allowedOrigins: ["https://app.test"],
      verify: async (id: string, auth: string) => id === owner && auth === "Bearer valid",
      connections: async () => {
        calls++;
        return { status: "unavailable", interfaces: {} };
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/connections?identity=${owner}`;
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: "Bearer bad" } })).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: "Bearer valid", Origin: "https://other.test" } })).status,
    ).toBe(403);
    expect(calls).toBe(0);
    const result = await fetch(url, { headers: { Authorization: "Bearer valid", Origin: "https://app.test" } });
    expect(result.status).toBe(503);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("local scene storage serves worker exports and ranges, blocks writes, traversal, hidden files and escaped symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memos-scene-"));
  const scenes = join(directory, "scenes"),
    key = "1-00000000-0000-4000-8000-000000000001";
  await mkdir(join(scenes, key), { recursive: true });
  await writeFile(join(scenes, key, "memory.json"), '{"synthetic":true}');
  await writeFile(join(scenes, key, "points.ply"), "test-points");
  await writeFile(join(directory, "secret.json"), "do not serve");
  await symlink(join(directory, "secret.json"), join(scenes, key, "escape.json"));
  const handle = await sceneStorage(scenes);
  const server = createServer(async (req, res) => {
    if (!(await handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/local-scenes/`;
  try {
    const response = await fetch(base + key + "/memory.json");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ synthetic: true });
    const range = await fetch(base + key + "/points.ply", { headers: { Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("test");
    expect((await fetch(base + key + "/points.ply", { method: "HEAD" })).headers.get("content-length")).toBe("11");
    expect((await fetch(base + key + "/points.ply", { headers: { Range: "bytes=99-100" } })).status).toBe(416);
    expect((await fetch(base + key + "/memory.json", { method: "PUT", body: "replace" })).status).toBe(405);
    for (const path of [
      key + "/escape.json",
      key + "/.worker-identity.json",
      key + "/%2e%2e%2f%2e%2e%2fsecret.json",
      key + "/missing.json",
      key + "/code.js",
      "%xx/memory.json",
    ]) {
      const missing = await fetch(base + path);
      expect(missing.status, path).toBe(404);
      expect(await missing.text()).not.toContain(directory);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
