import { afterEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { makeHandler } from "../server/upload/service.mjs";
import { decodePersonalKey, encodePersonalKey } from "../server/upload/accounts.mjs";
import { decodeAccountKey, encodeAccountKey } from "../apps/web/src/account-key";

const settings = { server: "https://db.example", database: "memos-test" };
const identity = "a".repeat(64), token = "header.payload.signature";
const account = { ...settings, identity, token };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
async function fixture() {
  let profile = { identity, displayName: "", provider: "guest" }, verifies = 0, created = 0;
  const server = createServer(makeHandler({
    accountConfig: settings, allowedOrigins: ["https://memos.example"],
    secret: "s".repeat(40), assetBase: "https://assets.example", pipelineIdentity: "b".repeat(64),
    registerIdentity: async () => { created++; return { identity, token }; },
    verify: async (id: string, auth: string) => { verifies++; return id === identity && auth === `Bearer ${token}`; },
    registerAccount: async (name: string) => {
      if (profile.provider === "key" && profile.displayName !== name) throw new Error("This key already belongs to a registered name");
      profile = { identity, displayName: name, provider: "key" };
    },
    getAccount: async () => profile,
    sign: async () => "https://assets.example/put", head: async () => ({ size: 100, type: "video/mp4" }),
    createMemory: async () => {}, listMemories: async () => [],
  }));
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, body?: unknown, bearer?: string) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { base, call, verifies: () => verifies, created: () => created };
}

test("server and website personal keys round-trip in both directions", () => {
  expect(decodePersonalKey(encodeAccountKey(account), settings)).toEqual(account);
  expect(decodeAccountKey(encodePersonalKey(account), { ...settings, uri: "wss://db.example" })).toEqual(account);
  for (const changed of [{ server: "https://evil.example" }, { database: "elsewhere" }, { identity: [] }, { token: "broken" }])
    expect(() => decodePersonalKey(encodePersonalKey({ ...account, ...changed }), settings)).toThrow();
});

test("account config, creation, key restoration and authenticated lookup match the phone contract", async () => {
  const f = await fixture();
  expect(await (await f.call("/api/account/config")).json()).toEqual({ version: 1, ...settings, keyPrefix: "memos1.", maxUploadBytes: 2147483648, pipelineAvailable: true });
  const response = await f.call("/api/account", { name: "  Jerry  " });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json();
  expect(result).toEqual({ ...account, displayName: "Jerry", provider: "key", personalKey: encodePersonalKey(account) });
  const restored = await f.call("/api/account", { personalKey: result.personalKey });
  expect(await restored.json()).toEqual(result);
  const read = await f.call("/api/account", undefined, result.personalKey);
  expect(await read.json()).toEqual({ ...settings, identity, displayName: "Jerry", provider: "key" });
  expect(f.created()).toBe(1);
  expect((await f.call("/api/account")).status).toBe(401);
});

test("an existing raw-token identity can be promoted without changing its owner", async () => {
  const f = await fixture();
  const result = await f.call("/api/account", { identity, displayName: "Phone user" }, token);
  expect(result.status).toBe(200); expect((await result.json()).identity).toBe(identity); expect(f.created()).toBe(0);
  expect((await f.call(`/api/account?identity=${identity}`, undefined, token)).status).toBe(200);
  expect((await f.call("/api/account", { displayName: "Different name" }, encodePersonalKey(account))).status).toBe(400);
});

test("forged, foreign, mismatched and unregistered personal keys cannot sign in", async () => {
  const f = await fixture();
  expect((await f.call("/api/account", { personalKey: encodePersonalKey(account) })).status).toBe(401);
  await f.call("/api/account", { name: "Jerry" });
  const before = f.verifies();
  expect((await f.call("/api/account", { personalKey: encodePersonalKey({ ...account, server: "https://attacker.example" }) })).status).toBe(401);
  expect(f.verifies()).toBe(before, "foreign key is rejected without contacting its embedded server");
  expect((await f.call("/api/account", { personalKey: encodePersonalKey({ ...account, token: "fake.payload.signature" }) })).status).toBe(401);
  expect((await f.call(`/api/memories?identity=${"b".repeat(64)}`, undefined, encodePersonalKey(account))).status).toBe(401);
  expect((await f.call("/api/account", { identity, name: "Stolen" })).status).toBe(401);
});

test("personal keys can upload/list without a separate identity; raw tokens remain compatible", async () => {
  const f = await fixture();
  await f.call("/api/account", { name: "Jerry" });
  const input = { name: "clip.mp4", type: "video/mp4", size: 100, title: "Phone clip", durationSec: 5, pipeline: true };
  const prepared = await f.call("/api/uploads/presign", input, encodePersonalKey(account));
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toMatchObject({ putUrl: "https://assets.example/put", headers: { "Content-Type": "video/mp4" }, pipeline: true });
  expect((await f.call("/api/uploads/presign", { ...input, identity }, token)).status).toBe(200);
  expect(await (await f.call("/api/memories", undefined, encodePersonalKey(account))).json()).toEqual({ memories: [] });
});

test("malformed, ambiguous and oversized account requests fail without creating identities", async () => {
  const f = await fixture();
  for (const body of [null, [], { name: "" }, { name: "x".repeat(41) }, { personalKey: encodePersonalKey(account), name: "Jerry" }])
    expect((await f.call("/api/account", body)).status).toBe(400);
  const oversized = await f.call("/api/account", { name: "x".repeat(33000) });
  expect(oversized.status).toBe(413);
  expect(f.created()).toBe(0);
  const denied = await fetch(f.base + "/api/account", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Jerry" }) });
  expect(denied.status).toBe(403);
  const preflight = await fetch(f.base + "/api/account", { method: "OPTIONS", headers: { Origin: "https://memos.example" } });
  expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
});
