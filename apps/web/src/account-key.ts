/** Passwords contain a host-signed credential, never a public identity alone. */
export interface AccountKey {
  server: string;
  database: string;
  identity: string;
  token: string;
}
const PREFIX = "memos1.";
const MAX_KEY_LENGTH = 16384;

export function databaseSettings() {
  const uri = import.meta.env.VITE_STDB_URL ||
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stdb/`;
  const database = import.meta.env.VITE_STDB_DATABASE || "memory-replay";
  const url = new URL(uri);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.pathname = url.pathname.replace(/\/$/, "");
  return { uri, database, server: url.href.replace(/\/$/, "") };
}
export function accountStorageKey() {
  const { server, database } = databaseSettings();
  return `memos-account:${server}/${database}`;
}
export function encodeAccountKey(account: AccountKey): string {
  const bytes = new TextEncoder().encode(JSON.stringify(account));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Shape and destination checks only; SpacetimeDB must verify the signature. */
export function decodeAccountKey(input: string, expected = databaseSettings()): AccountKey {
  const value = input.trim();
  if (!value.startsWith(PREFIX) || value.length > MAX_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value.slice(PREFIX.length)))
    throw new Error("Paste the complete password starting with memos1. A party code is different.");
  let data: AccountKey;
  try {
    const bytes = Uint8Array.from(atob(value.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || typeof data.token !== "string" || data.token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token) ||
      typeof data.identity !== "string" || !/^[0-9a-f]{64}$/.test(data.identity)) throw new Error();
  } catch { throw new Error("This password is incomplete or damaged. Paste your saved password again."); }
  if (data.server !== expected.server || data.database !== expected.database)
    throw new Error("This password belongs to a different memos server. Open the site where you created it.");
  return { server: data.server, database: data.database, identity: data.identity, token: data.token };
}
export function savedAccount(): AccountKey | undefined {
  try {
    const key = accountStorageKey();
    const value = globalThis.sessionStorage?.getItem(key) || globalThis.localStorage?.getItem(key);
    return value ? decodeAccountKey(value) : undefined;
  } catch { return undefined; }
}
/** Keep this tab signed in even where persistent storage is unavailable. */
export function saveAccount(account: AccountKey): boolean {
  const key = accountStorageKey(), value = encodeAccountKey(account);
  sessionStorage.setItem(key, value);
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}
export function forgetAccount() {
  const key = accountStorageKey();
  sessionStorage.removeItem(key);
  // Registration may have promoted this tab's guest identity to a named account.
  const database = databaseSettings().database;
  sessionStorage.removeItem(`memreplay-token:${database}`);
  // The library persists its guest token separately. After promotion it is also an account credential.
  try { localStorage.removeItem(`memreplay-library-token:${database}`); } catch { /* unavailable storage */ }
  sessionStorage.removeItem("memreplay-google-credential");
  // Broadcast sign-out only after clearing guest credentials that other library tabs could reuse.
  try { localStorage.removeItem(key); } catch { /* unavailable storage */ }
}
