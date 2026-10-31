import { expect, test } from "vitest";
import { createServer } from "node:http";
import { RecordedUpload } from "../src/upload/recorded";

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
    if (req.url?.startsWith("/api/") && req.headers.authorization !== "Bearer test-token")
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
      if (completes === 1) return json(503, { error: "Temporary database outage" });
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
    const attempt = new RecordedUpload(file, 2, "[SIMULATION] Test", "a".repeat(64), "test-token", base);
    await expect(attempt.run(() => {})).rejects.toThrow("Temporary database outage");
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

test("a test recording asks for pipeline:false and checks its row is not the worker's", async () => {
  const identity = "a".repeat(64),
    worker = "b".repeat(64);
  let presigned: any,
    echo: boolean | undefined = false,
    assigned = identity,
    puts = 0,
    base = "";
  const stored = new Uint8Array([5, 6, 7, 8]);
  const server = createServer(async (req, res) => {
    const json = (value: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const row = {
      id: "7",
      requestId: "sim",
      sourceUrl: `${base}/video`,
      pipelineIdentity: assigned,
    };
    if (req.url === "/api/uploads/presign") {
      presigned = JSON.parse(Buffer.concat(chunks).toString());
      return json({
        putUrl: `${base}/put`,
        receipt: "r",
        requestId: "sim",
        receiptExpiresAt: Date.now() + 60000,
        headers: { "Content-Type": "video/webm" },
        ...(echo === undefined ? {} : { pipeline: echo }),
      });
    }
    if (req.url === "/put") {
      puts++;
      res.writeHead(200);
      return res.end();
    }
    if (req.url === "/api/uploads/complete") return json({ memory: row });
    if (req.url?.startsWith("/api/memories?")) return json({ memories: [row] });
    res.writeHead(200);
    res.end(stored);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const recording = () =>
    new RecordedUpload(
      new File([stored], "sim.webm", { type: "video/webm" }),
      2,
      "[SIMULATION] Test",
      identity,
      "token",
      base,
      false,
    );
  try {
    expect((await recording().run(() => {})).id).toBe("7");
    expect(presigned.pipeline).toBe(false);
    expect(puts).toBe(1);
    // An upload service that ignores the flag: stop before any bytes are sent.
    echo = undefined;
    await expect(recording().run(() => {})).rejects.toThrow("does not support test uploads");
    expect(puts).toBe(1);
    // The database row is assigned to the worker: the verification fails.
    echo = false;
    assigned = worker;
    await expect(recording().run(() => {})).rejects.toThrow("assigned to the pipeline worker");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
