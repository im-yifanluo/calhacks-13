import { afterEach, expect, test, vi } from "vitest";
import { databaseConfig } from "../server/upload/service.mjs";
afterEach(() => vi.unstubAllGlobals());
test("phone memory listing exposes scene output and preserves owner filtering", async () => {
  const identity = "a".repeat(64), pipeline = "b".repeat(64);
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.body).toContain(`WHERE owner = 0x${identity}`);
    expect(options.body).toContain("manifest_url, progress, error");
    expect(options.headers).toEqual({ Authorization: "Bearer test" });
    return new Response(JSON.stringify([{ rows: [[4, "Kitchen", "https://assets.test/clip.mov", "ready", 17000000, "request", [`0x${pipeline}`], "https://assets.test/memory.json", 1, ""]] }]));
  });
  vi.stubGlobal("fetch", fetch);
  const db = databaseConfig({ STDB_HTTP_URL: "https://db.test", STDB_DATABASE: "test" });
  expect(await db.listMemories(identity, "Bearer test")).toEqual([{
    id: "4", title: "Kitchen", sourceUrl: "https://assets.test/clip.mov", status: "ready", durationUs: "17000000",
    requestId: "request", pipelineIdentity: pipeline, manifestUrl: "https://assets.test/memory.json", progress: 1, error: "",
  }]);
  await expect(db.listMemories("invalid' OR 1=1", "Bearer test")).rejects.toThrow("Invalid identity");
  expect(fetch).toHaveBeenCalledTimes(1);
});
