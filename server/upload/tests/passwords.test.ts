import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { databaseConfig } from "../src/database.mjs";
import { s3PasswordStore } from "../src/node/passwords-s3.mjs";
import { localPasswordStore } from "../src/node/passwords-sqlite.mjs";
import { passwordVault, r2PasswordStore, validPassword } from "../src/passwords.mjs";

const settings = { server: "https://db.test", database: "memos" },
  secret = "test-server-secret-".repeat(4);
const account = { ...settings, identity: "a".repeat(64), token: "header.privatepayload.signature" };
const second = { ...account, identity: "b".repeat(64), token: "header.otherpayload.signature" };
function memoryStore() {
  const data = new Map<string, { value: string; version: string }>();
  let sequence = 0;
  return {
    data,
    async read(key: string) {
      return data.get(key) ?? null;
    },
    async write(key: string, value: string, version?: string) {
      if (data.get(key)?.version !== version) return false;
      data.set(key, { value, version: String(++sequence) });
      return true;
    },
  };
}
const vault = (store: any, overrides = {}) => passwordVault({ store, settings, secret, ...overrides });
afterEach(() => vi.restoreAllMocks());

test("the public /stdb account alias matches browser sessions while verification stays on the internal database", async () => {
  const backend = databaseConfig({
    STDB_HTTP_URL: "http://127.0.0.1:3055",
    STDB_DATABASE: "memos",
    ACCOUNT_SERVER_URL: "https://memos.test/stdb",
  });
  expect(backend.accountConfig).toEqual({ server: "https://memos.test/stdb", database: "memos" });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  expect(await backend.verify(account.identity, `Bearer ${account.token}`)).toBe(true);
  expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:3055/v1/identity/${account.identity}/verify`);
  await backend.registerAccount("Jerry", `Bearer ${account.token}`);
  expect(fetch.mock.calls[1][0]).toBe("http://127.0.0.1:3055/v1/database/memos/call/register_account");
});

test("passwords are six ASCII digits, preserve leading zeros, and never alias malformed inputs", async () => {
  const store = memoryStore(),
    service = vault(store, { generate: () => "000007" });
  const password = await service.issue(account, "phone");
  expect(password).toBe("000007");
  expect(await service.restore(password, "desktop")).toEqual(account);
  for (const input of ["00007", "0000077", "000007\n", " 000007", "１２３４５６", "abc123", 7, null]) {
    expect(validPassword(input)).toBe(false);
    await expect(service.restore(input, "desktop")).rejects.toMatchObject({ status: 400 });
  }
  const saved = JSON.stringify([...store.data]);
  expect(saved).not.toContain(account.token);
  expect(saved).not.toContain(account.identity);
});

test("collisions retry; replicas and concurrent issuance keep one password per identity", async () => {
  const store = memoryStore();
  const service = vault(store, {
    generate: vi.fn().mockReturnValueOnce("000007").mockReturnValueOnce("000007").mockReturnValue("123456"),
  });
  expect(await service.issue(account, "phone")).toBe("000007");
  expect(await service.issue(second, "phone")).toBe("123456");
  const replicas = [service, vault(store), vault(store), vault(store)];
  expect(await Promise.all(replicas.map((replica) => replica.issue(account, "phone")))).toEqual(
    Array(4).fill("000007"),
  );
  expect(await replicas[1].restore("000007", "new-device")).toEqual(account);
  expect(await replicas[2].restore("123456", "new-device")).toEqual(second);
  const versions = [...store.data.values()].map((row) => row.version);
  await replicas[3].issue(account, "phone");
  expect([...store.data.values()].map((row) => row.version)).toEqual(versions);
});

test("failed attempts, successful attempts, and rate limits persist across replicas; counters expire", async () => {
  const store = memoryStore();
  let time = 0;
  const service = vault(store, { now: () => time, generate: () => "000007" });
  await service.issue(account, "phone");
  for (let n = 0; n < 5; n++)
    await expect(vault(store, { now: () => time }).restore("999999", "guessing-client")).rejects.toMatchObject({
      status: 401,
    });
  await expect(service.restore("000007", "guessing-client")).rejects.toMatchObject({ status: 429 });
  expect(await service.restore("000007", "other-client")).toEqual(account);
  time = 900_001;
  expect(await service.restore("000007", "guessing-client")).toEqual(account);
  for (let n = 0; n < 4; n++) await service.restore("000007", "guessing-client");
  await expect(service.restore("000007", "guessing-client")).rejects.toMatchObject({ status: 429 });
});

test("global guessing limit cannot be bypassed by changing source addresses", async () => {
  const service = vault(memoryStore(), { now: () => 0 });
  for (let n = 0; n < 30; n++)
    await expect(service.restore("999999", `client-${n}`)).rejects.toMatchObject({ status: 401 });
  await expect(service.restore("999999", "another-client")).rejects.toMatchObject({ status: 429 });
});

test("creation is limited and collisions never overwrite an existing account", async () => {
  const store = memoryStore(),
    service = vault(store, { generate: () => "000007" });
  await service.issue(account, "phone");
  await expect(service.issue(second, "phone")).rejects.toMatchObject({ status: 503 });
  expect(await service.restore("000007", "reader")).toEqual(account);
  const allocating = vault(memoryStore());
  for (let n = 0; n < 5; n++) await allocating.issue({ ...account, identity: String(n).repeat(64) }, "same-client");
  await expect(allocating.issue(second, "same-client")).rejects.toMatchObject({ status: 429 });
});

test("unavailable, corrupted, or continuously conflicting storage fails closed without leaking data", async () => {
  const broken = {
    read: async () => {
      throw new Error("/private/secret/passwords");
    },
  };
  await expect(vault(broken).restore("123456", "client")).rejects.toMatchObject({
    status: 503,
    message: "Password service unavailable. Please retry.",
  });
  const conflict = { read: async () => null, write: async () => false };
  await expect(vault(conflict).issue(account, "client")).rejects.toMatchObject({ status: 503 });
  const store = memoryStore(),
    service = vault(store);
  await service.issue(account, "client");
  for (const item of store.data.values()) item.value = "corrupted";
  await expect(service.restore("123456", "client")).rejects.toMatchObject({ status: 503 });
});

test("SQLite persists passwords and attempts across reopen; two processes cannot overwrite a newer version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memos-password-test-"));
  const path = join(directory, "accounts.sqlite");
  let first = localPasswordStore(path),
    secondStore: ReturnType<typeof localPasswordStore> | undefined;
  try {
    const password = await vault(first).issue(account, "phone");
    await expect(vault(first).restore("bad", "phone")).rejects.toMatchObject({ status: 400 });
    for (let n = 0; n < 5; n++) await vault(first).restore(password, "phone");
    first.close();
    first = localPasswordStore(path);
    secondStore = localPasswordStore(path);
    await expect(vault(secondStore).restore(password, "phone")).rejects.toMatchObject({ status: 429 });
    expect(await vault(first).restore(password, "desktop")).toEqual(account);
    expect(await Promise.all([first.write("cas", "one"), secondStore.write("cas", "two")])).toEqual([true, false]);
  } finally {
    first.close();
    secondStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2 and S3 adapters enforce conditional writes rather than last-writer-wins", async () => {
  const data = memoryStore();
  const bucket = {
    async get(key: string) {
      const value = await data.read(key);
      return value && { text: async () => value.value, etag: value.version };
    },
    async put(key: string, value: string, options: any) {
      const ok = await data.write(key, value, options.onlyIf.etagMatches);
      return ok ? {} : null;
    },
  };
  const r2 = r2PasswordStore(bucket);
  expect(await r2.write("r2", "one")).toBe(true);
  expect(await r2.write("r2", "two")).toBe(false);
  const read = await r2.read("r2");
  expect(await r2.write("r2", "two", read!.version)).toBe(true);
  const send = vi
    .fn()
    .mockResolvedValueOnce({ Body: { transformToString: async () => "one" }, ETag: "v1" })
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } });
  const s3 = s3PasswordStore({ send }, "private-accounts");
  expect(await s3.read("s3")).toEqual({ value: "one", version: "v1" });
  expect(await s3.write("s3", "two", "v1")).toBe(true);
  expect(send.mock.calls[1][0].input).toMatchObject({ Bucket: "private-accounts", IfMatch: "v1" });
  expect(await s3.write("s3", "three")).toBe(false);
  expect(send.mock.calls[2][0].input).toMatchObject({ IfNoneMatch: "*" });
});

test("R2 throttling waits, re-reads and retries instead of losing the account allocation", async () => {
  vi.useFakeTimers();
  try {
    let object: { value: string; version: string } | null = null;
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error("put: rate limited (429)"))
      .mockImplementation(async (_key: string, value: string) => {
        object = { value, version: "v1" };
        return {};
      });
    const get = vi.fn(async () => object && { text: async () => object!.value, etag: object.version });
    const service = vault(r2PasswordStore({ get, put }), { generate: () => "000007" });
    const pending = service.issue(account, "client");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe("000007");
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
