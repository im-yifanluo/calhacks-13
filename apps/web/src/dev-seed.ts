import type { Multiplayer } from "./net/index.js";

/**
 * Local development only: put every scene under apps/web/public/memories/ (not in git; the pipeline lists them in
 * status.json) into the signed-in account's library, or the guest's, so the memory cards can be seen with real
 * data. Memories already in the library are skipped. Nothing here runs in a production build.
 */
export const LOCAL_INDEX = "/memories/status.json";

const requestId = () =>
  crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The memory.json URLs of the local scenes, or none (not a dev server, or no scenes unpacked). */
export async function localMemoryUrls(origin = location.origin): Promise<string[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const response = await fetch(new URL(LOCAL_INDEX, origin));
    if (!response.ok) return [];
    const index = (await response.json()) as { scenes?: { id?: unknown }[] };
    return (index.scenes ?? [])
      .map((scene) => scene.id)
      .filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id))
      .map((id) => new URL(`/memories/${id}/memory.json`, origin).href);
  } catch {
    return [];
  }
}

export interface SeedResult {
  added: number;
  skipped: number;
  failed: string[];
}

/** Add each local scene that is not in the library yet. `onProgress` gets (done, total). */
export async function seedLocalMemories(
  net: Multiplayer,
  onProgress?: (done: number, total: number) => void,
): Promise<SeedResult> {
  const urls = await localMemoryUrls();
  const result: SeedResult = { added: 0, skipped: 0, failed: [] };
  const same = (a: string, b: string) => {
    try {
      return new URL(a, location.origin).href === b;
    } catch {
      return false;
    }
  };
  for (const [index, url] of urls.entries()) {
    if (net.memories.some((m) => same(m.manifestUrl, url))) result.skipped++;
    else {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`memory.json returned ${response.status}`);
        const manifest = (await response.json()) as { title?: unknown; timeline?: { durationSec?: unknown } };
        const seconds = Number(manifest.timeline?.durationSec);
        if (typeof manifest.title !== "string" || !Number.isFinite(seconds)) throw new Error("not a memory.json");
        const title = manifest.title;
        const error = await net.attempt(
          () =>
            net.connection!.reducers.createMemory({
              requestId: requestId(),
              title,
              sourceUrl: "",
              manifestUrl: url,
              pipelineIdentity: net.identity!,
              durationUs: BigInt(Math.round(seconds * 1e6)),
            }),
          null,
          true,
        );
        if (error) throw new Error(error);
        result.added++;
      } catch (error) {
        result.failed.push(
          `${url.split("/").slice(-2, -1)[0]}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    onProgress?.(index + 1, urls.length);
  }
  return result;
}

export function seedSummary(result: SeedResult): string {
  const parts = [`Added ${result.added} local ${result.added === 1 ? "memory" : "memories"}`];
  if (result.skipped) parts.push(`${result.skipped} already there`);
  if (result.failed.length) parts.push(`${result.failed.length} failed (${result.failed.join("; ")})`);
  return `${parts.join(", ")}.`;
}
