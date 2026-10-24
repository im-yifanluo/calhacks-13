import { expect, test } from "vitest";
import { createServer } from "node:http";
import { RecordedUpload } from "../apps/web/src/recorded-upload";

test("automatic capture retries confirmation without another PUT and independently verifies stored bytes", async () => {
  let puts = 0,
    completes = 0,
    lists = 0,
    corrupt = false;
  let stored = Buffer.alloc(0),
    base = "";
  const row = { id: "19", requestId: "test-recording", sourceUrl: "" };
  const server = createServer(async (req, res) => {
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (
      req.url?.startsWith("/api/") &&
      req.headers.authorization !== "Bearer test-token"
    )
      return json(401, { error: "Invalid token" });
    if (req.url === "/api/uploads/presign")
      return json(200, {
        putUrl: `${base}/put`,
        receipt: "test-receipt",
        requestId: row.requestId,
        receiptExpiresAt: Date.now() + 60000,
        headers: { "Content-Type": "video/webm" },
      });
    if (req.url === "/put") {
      puts++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      stored = Buffer.concat(chunks);
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === "/api/uploads/complete") {
      completes++;
      if (completes === 1)
        return json(503, { error: "Temporary database outage" });
      return json(200, { memory: row });
    }
    if (req.url?.startsWith("/api/memories?")) {
      lists++;
      return json(200, { memories: [row] });
    }
    if (req.url === "/video") {
      res.writeHead(200);
      res.end(corrupt ? Buffer.from("changed") : stored);
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  row.sourceUrl = `${base}/video`;
  try {
    // Transport bytes, deliberately not a decodable video; browser QA covers encoding/playback.
    const file = new File([new Uint8Array([1, 2, 3, 4])], "clip.webm", {
      type: "video/webm",
    });
    const attempt = new RecordedUpload(
      file,
      2,
      "[SIMULATION] Test",
      "a".repeat(64),
      "test-token",
      base,
    );
    await expect(attempt.run(() => {})).rejects.toThrow(
      "Temporary database outage",
    );
    const verified = await attempt.run(() => {});
    expect(verified.id).toBe("19");
    expect(verified.size).toBe(4);
    expect(verified.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(puts).toBe(1);
    expect(completes).toBe(2);
    expect(lists).toBe(1);
    corrupt = true;
    await expect(attempt.run(() => {})).rejects.toThrow("does not match");
    expect(puts).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
