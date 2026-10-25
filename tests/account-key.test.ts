import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Identity } from "spacetimedb";
import { DbConnection } from "../apps/web/src/module_bindings";
import { accountStorageKey, databaseSettings, decodeAccountKey, encodeAccountKey, forgetAccount, saveAccount, savedAccount, type AccountKey } from "../apps/web/src/account-key";
import { verifySignInKey } from "../apps/web/src/auth";

function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
const identity = new Identity(19n);
const account: AccountKey = { server: "https://maincloud.example", database: "memos-test", identity: identity.toHexString(), token: "header.payload.signature" };
beforeEach(() => {
  vi.stubEnv("VITE_STDB_URL", "wss://maincloud.example/");
  vi.stubEnv("VITE_STDB_DATABASE", "memos-test");
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("localStorage", storage());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("personal key format and storage", () => {
  test("a key carries the signed credential and exact destination, with no name or party data", () => {
    expect(databaseSettings().server).toBe(account.server);
    const key = encodeAccountKey(account);
    expect(decodeAccountKey(` ${key}\n`)).toEqual(account);
    expect(key).toMatch(/^memos1\.[A-Za-z0-9_-]+$/);
    expect(Object.keys(decodeAccountKey(key)).sort()).toEqual(["database", "identity", "server", "token"]);
  });
  test("party codes, public IDs, damaged keys and keys from other servers are rejected", () => {
    for (const input of ["", "ABC1234", identity.toHexString(), "memos1.bad!", "memos1.AAAA", "memos1." + "a".repeat(16384)])
      expect(() => decodeAccountKey(input)).toThrow();
    for (const changed of [{ database: "another" }, { server: "https://impostor.example" }])
      expect(() => decodeAccountKey(encodeAccountKey({ ...account, ...changed }))).toThrow(/different memos server/);
    expect(() => decodeAccountKey(encodeAccountKey({ ...account, token: "not-a-token" }))).toThrow(/damaged/);
  });
  test("registration is remembered across tab restarts and sign-out clears account and guest fallback", () => {
    expect(saveAccount(account)).toBe(true);
    vi.stubGlobal("sessionStorage", storage());
    expect(savedAccount()).toEqual(account);
    sessionStorage.setItem("memreplay-token:memos-test", account.token);
    forgetAccount();
    expect(savedAccount()).toBeUndefined();
    expect(localStorage.getItem(accountStorageKey())).toBeNull();
    expect(sessionStorage.getItem("memreplay-token:memos-test")).toBeNull();
  });
  test("when persistent storage is blocked the key still works for this tab", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} });
    expect(saveAccount(account)).toBe(false);
    expect(savedAccount()).toEqual(account);
    forgetAccount();
    expect(savedAccount()).toBeUndefined();
  });
});

describe("key sign-in verification", () => {
  function verifier(profile: { provider: string; displayName: string } | undefined = { provider: "key", displayName: "Saved Name" }) {
    const on: Record<string, (...args: any[]) => void> = {};
    let applied = () => {};
    const subscription: any = { onApplied(cb: () => void) { applied = cb; return subscription; }, onError() { return subscription; }, subscribe() {} };
    const conn = { db: { profile: { identity: { find: () => profile } } }, subscriptionBuilder: () => subscription, disconnect: vi.fn(() => on.onDisconnect?.()) };
    const builder: any = new Proxy({}, { get: (_target, method: string) => (...args: any[]) => {
      if (method.startsWith("on")) on[method] = args[0];
      if (method === "withToken") expect(args[0]).toBe(account.token);
      if (method === "withUri") expect(args[0]).toBe("wss://maincloud.example/");
      return method === "build" ? conn : builder;
    } });
    vi.spyOn(DbConnection, "builder").mockReturnValue(builder);
    return { on, conn, applied: () => applied() };
  }
  test("only a host-verified identity plus its registered profile restores the saved name", async () => {
    const { on, conn, applied } = verifier();
    const login = verifySignInKey(encodeAccountKey(account));
    on.onConnect(conn, identity);
    applied();
    expect(await login).toEqual({ account, name: "Saved Name" });
    expect(conn.disconnect).toHaveBeenCalledOnce();
    expect(savedAccount()).toBeUndefined(); // UI commits only after successful verification
  });
  test("a rejected key does not overwrite the current saved account", async () => {
    saveAccount(account);
    const { on, conn } = verifier();
    const login = verifySignInKey(encodeAccountKey(account));
    const rejected = expect(login).rejects.toThrow(/rejected/);
    on.onConnectError({}, new Error("Invalid signature"));
    await rejected;
    expect(savedAccount()).toEqual(account);
    expect(conn.disconnect).toHaveBeenCalledOnce();
  });
  test("forging the public identity in an otherwise well-formed key is rejected", async () => {
    const { on, conn } = verifier();
    const login = verifySignInKey(encodeAccountKey(account));
    const rejected = expect(login).rejects.toThrow(/could not be verified/);
    on.onConnect(conn, new Identity(20n));
    await rejected;
    expect(savedAccount()).toBeUndefined();
  });
  test("an anonymous token alone cannot claim an unregistered name", async () => {
    const { on, conn, applied } = verifier({ provider: "guest", displayName: "" });
    const login = verifySignInKey(encodeAccountKey(account));
    const rejected = expect(login).rejects.toThrow(/no registered name/);
    on.onConnect(conn, identity); applied(); await rejected;
  });
  test("failed verification times out and closes the temporary connection", async () => {
    vi.useFakeTimers();
    const { conn } = verifier();
    const rejected = expect(verifySignInKey(encodeAccountKey(account), 100)).rejects.toThrow(/Check your connection/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(conn.disconnect).toHaveBeenCalledOnce();
  });
});
