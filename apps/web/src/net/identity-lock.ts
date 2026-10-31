// One SpacetimeDB identity per tab: a page holds a Web Lock named after its stored token while it uses it.

/** The part of the Web Locks API (`navigator.locks`) used to tell tabs apart. */
export type Locks = Pick<LockManager, "request">;
/** How long a page waits for its stored identity before deciding another live tab uses it (ms). */
export const IDENTITY_WAIT_MS = 1000;

/** A short, stable tag for a token, so lock names never contain the token itself (53-bit cyrb53). */
export function tokenTag(token: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export const lockName = (key: string, token: string) => `${key}:${tokenTag(token)}`;

/**
 * Holds the exclusive Web Lock `name` until the returned function is called. Resolves to undefined
 * when another page still holds it after `waitMs` (0: only if it is free right now). Without Web
 * Locks (an insecure origin, an old browser) every page gets it.
 */
export function holdLock(locks: Locks | undefined, name: string, waitMs: number): Promise<(() => void) | undefined> {
  const none = () => {};
  if (!locks) return Promise.resolve(none);
  return new Promise((resolve) => {
    let letGo = none;
    const held = new Promise<void>((done) => (letGo = done));
    const abort = new AbortController();
    const timer = waitMs > 0 ? setTimeout(() => abort.abort(), waitMs) : undefined;
    const options: LockOptions = waitMs > 0 ? { signal: abort.signal } : { ifAvailable: true };
    // AbortError: still held elsewhere after waitMs. Any other error means locks don't work here.
    const failed = (error: unknown) => {
      clearTimeout(timer);
      resolve((error as Error)?.name === "AbortError" ? undefined : none);
    };
    try {
      locks
        .request(name, options, (lock) => {
          clearTimeout(timer);
          resolve(lock ? letGo : undefined);
          return lock ? held : undefined;
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  });
}

/**
 * The token this page may connect with. A duplicated tab, or a window the app opens, starts with a
 * copy of its opener's sessionStorage, so with the same SpacetimeDB identity, and two tabs with one
 * identity release each other's objects. Every page holds a Web Lock named after its token while it
 * uses it; a page that finds the lock taken drops its copy and connects as a new guest. A reload
 * waits up to `waitMs` for its previous page to let go.
 */
export async function claimStoredToken(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  locks: Locks | undefined,
  waitMs = IDENTITY_WAIT_MS,
): Promise<{ token?: string; release: () => void }> {
  const token = storage.getItem(key) || undefined;
  if (!token) return { release: () => {} };
  const release = await holdLock(locks, lockName(key, token), waitMs);
  if (release) return { token, release };
  storage.removeItem(key);
  return { release: () => {} };
}
