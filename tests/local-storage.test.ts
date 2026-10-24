import { expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStorage } from "../server/upload/local.mjs";
import { ticket } from "../server/upload/service.mjs";
const secret = "local-test-secret".repeat(3),
  key = `videos/${"a".repeat(64)}/00000000-0000-4000-8000-000000000001.mp4`;
test("local storage persists exact bytes, supports playback ranges and rejects invalid upload tickets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memreplay-storage-"));
  const storage = await localStorage({
    directory,
    secret,
    publicOrigin: "http://localhost",
  });
  const server = createServer(async (req, res) => {
    if (!(await storage.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const data = { key, size: 4, type: "video/mp4", expires: Date.now() + 60000 };
  const put = (receipt: string, body: number[]) =>
    fetch(`${base}/api/local-upload?receipt=${encodeURIComponent(receipt)}`, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array(body),
    });
  try {
    expect((await put(ticket(data, secret) + "x", [1, 2, 3, 4])).status).toBe(
      400,
    );
    expect((await put(ticket(data, secret), [1, 2])).status).toBe(400);
    expect((await put(ticket(data, secret), [1, 2, 3, 4])).status).toBe(200);
    const restarted = await localStorage({
      directory,
      secret,
      publicOrigin: base,
    });
    expect((await restarted.head(key)).size).toBe(4);
    const media = `${base}/api/local-media/${key}`;
    expect([
      ...new Uint8Array(await (await fetch(media)).arrayBuffer()),
    ]).toEqual([1, 2, 3, 4]);
    const range = await fetch(media, { headers: { Range: "bytes=1-2" } });
    expect(range.status).toBe(206);
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3]);
    expect(
      (await fetch(media, { method: "HEAD" })).headers.get("x-content-sha256"),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect((await put(ticket(data, secret), [9, 9, 9, 9])).status).toBe(400);
    expect([
      ...new Uint8Array(await (await fetch(media)).arrayBuffer()),
    ]).toEqual([1, 2, 3, 4]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
