// Room and scene addresses: /CODE joins a party, / is solo, and the scene URL stays out of the shared address.

/** main.ts loads this manifest when the URL has no ?memory= (its built-in demo). */
export const DEFAULT_MANIFEST = "/demo/memory.json";
/** sessionStorage: the room URL this tab last reloaded into to open the room's memory. */
export const RELOAD_GUARD_KEY = "memreplay-room-reload";

export const normalizeCode = (code: string | null | undefined) => (code ?? "").trim().toUpperCase();

/** /CODE is canonical. Old ?room= invitations still work; a path code takes precedence. */
export function roomCode(href: string): string {
  const url = new URL(href);
  const match = /^\/([a-z0-9]{7})\/?$/i.exec(url.pathname);
  return normalizeCode(match?.[1] ?? url.searchParams.get("room"));
}

const ROOM_MANIFEST_KEY = "memreplay-room-manifest:";

/** Explicit former origins of this app, for scene records saved before a hostname rename. */
export function resolveManifestUrl(value: string, base: string): string {
  const url = new URL(value, base);
  const aliases = (import.meta.env.VITE_ASSET_ORIGIN_ALIASES ?? "").split(",").map((origin: string) => origin.trim());
  if (aliases.includes(url.origin)) {
    const current = new URL(base);
    url.protocol = current.protocol;
    url.host = current.host;
  }
  return url.href;
}

/** Only a hint for the next load. The database always checks and replaces it after joining. */
export function rememberRoomManifest(storage: Pick<Storage, "setItem">, code: string, manifest: string): void {
  storage.setItem(ROOM_MANIFEST_KEY + normalizeCode(code), manifest);
}

/** Resolve the scene without putting its asset URL in the shared room address. */
export function loadedManifest(href: string, storage?: Pick<Storage, "getItem">): string {
  const url = new URL(href);
  const code = roomCode(href);
  const roomManifest = code ? storage?.getItem(ROOM_MANIFEST_KEY + code) : null;
  return resolveManifestUrl(roomManifest ?? url.searchParams.get("memory") ?? DEFAULT_MANIFEST, href);
}

export function sameManifest(a: string, b: string, base: string): boolean {
  return resolveManifestUrl(a, base) === resolveManifestUrl(b, base);
}

/**
 * One server origin: /CODE joins a party, / starts solo. Scene URLs stay in the database.
 */
export function roomUrl(href: string, code: string | null): string {
  const url = new URL(href);
  url.pathname = code ? `/${normalizeCode(code)}` : "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

/** One automatic reload per target URL per tab, so a manifest that never matches cannot loop. */
export function claimReload(storage: Pick<Storage, "getItem" | "setItem">, target: string): boolean {
  if (storage.getItem(RELOAD_GUARD_KEY) === target) return false;
  storage.setItem(RELOAD_GUARD_KEY, target);
  return true;
}
