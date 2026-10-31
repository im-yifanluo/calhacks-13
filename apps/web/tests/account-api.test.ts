import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { accountPassword, createPasswordAccount, restorePassword } from "../src/account-api";
import { encodeAccountKey } from "../src/account-key";

const account = { server: "https://db.test", database: "memos", identity: "a".repeat(64), token: "aaa.bbb.ccc" };
const response = {
  ...account,
  displayName: "Jerry",
  provider: "key",
  personalKey: encodeAccountKey(account),
  password: "000007",
};
beforeEach(() => {
  vi.stubEnv("VITE_STDB_URL", "wss://db.test");
  vi.stubEnv("VITE_STDB_DATABASE", "memos");
  vi.stubEnv("VITE_UPLOAD_API", "https://api.test");
  vi.stubGlobal("location", new URL("https://memos.test"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
/** fetch as account-api calls it: always with plain headers, and with a JSON string body for POSTs. */
type Fetch = (url: string, init: { headers: Record<string, string>; body?: string }) => Promise<Response>;
function mockAPI(value: object = response, config = { ...account, passwordLength: 6 }) {
  const fetch = vi.fn<Fetch>(async (url) => Response.json(url.endsWith("/config") ? config : value));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("six-digit login sends a string, preserves leading zeros and resolves the existing identity", async () => {
  const fetch = mockAPI();
  expect(await restorePassword("000007")).toEqual({ account: { ...account, password: "000007" }, name: "Jerry" });
  expect(JSON.parse(fetch.mock.calls[1][1].body!)).toEqual({ password: "000007" });
  expect(fetch.mock.calls[1][0]).toBe("https://api.test/api/account");
});
test("creation promotes the current guest and rejects an unexpected identity", async () => {
  const fetch = mockAPI();
  expect((await createPasswordAccount("Jerry", account)).account.identity).toBe(account.identity);
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${account.token}`);
  mockAPI({ ...response, identity: "b".repeat(64) });
  await expect(createPasswordAccount("Jerry", account)).rejects.toThrow("invalid account");
});
test("wrong destination is rejected before sending the account credential", async () => {
  const fetch = mockAPI(response, { ...account, database: "elsewhere", passwordLength: 6 });
  await expect(createPasswordAccount("Jerry", account)).rejects.toThrow("different database");
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("old sessions can obtain a short password without changing identity; cached passwords need no request", async () => {
  const fetch = mockAPI({ password: "000007" });
  expect(await accountPassword(account)).toBe("000007");
  expect(fetch.mock.calls[1][0]).toBe("https://api.test/api/account/password");
  expect(JSON.parse(fetch.mock.calls[1][1].body!)).toEqual({ identity: account.identity });
  fetch.mockClear();
  expect(await accountPassword({ ...account, password: "000007" })).toBe("000007");
  expect(fetch).not.toHaveBeenCalled();
});
test("bad formats, older servers and rate limits produce useful errors", async () => {
  const fetch = mockAPI();
  for (const password of ["12345", "1234567", "abcdef", "１２３４５６"])
    await expect(restorePassword(password)).rejects.toThrow("six digits");
  expect(fetch).not.toHaveBeenCalled();
  mockAPI(response, { ...account, passwordLength: 0 });
  await expect(restorePassword("000007")).rejects.toThrow("Update the upload service");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/config")
        ? Response.json({ ...account, passwordLength: 6 })
        : Response.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 }),
    ),
  );
  await expect(restorePassword("000007")).rejects.toThrow("Too many attempts");
});
