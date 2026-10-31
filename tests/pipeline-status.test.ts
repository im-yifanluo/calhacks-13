import { expect, test } from "vitest";
import { createServer } from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The worker's Python helpers: scripts/pipeline-status.py (status reports, run against a stub
// of SpacetimeDB's reducer endpoint) and scripts/source_check.py (which sourceUrl to fetch).
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const python = spawnSync("python3", ["--version"]).status === 0;

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "python3",
      ["-I", ...args],
      { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20000 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? Number((error as any).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

test.skipIf(!python)("pipeline-status.py reports, prints the reducer's reason and truncates long errors", async () => {
  const status = (args: string[], env: Record<string, string>) => run([script("pipeline-status.py"), ...args], env);
  const received: { url?: string; auth?: string; args: any[] }[] = [];
  let reply = { code: 200, body: "" };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      auth: req.headers.authorization,
      args: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(reply.code);
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    STDB_HTTP_URL: `http://127.0.0.1:${(server.address() as any).port}/`,
    STDB_DATABASE: "memory-replay",
    PIPELINE_TOKEN: "worker-token",
  };
  try {
    const ok = await status(["12", "processing", "--progress", "0.5"], env);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.stdout).toContain("Status accepted: 200");
    expect(received[0]).toEqual({
      url: "/v1/database/memory-replay/call/set_memory_status",
      auth: "Bearer worker-token",
      args: [12, "processing", 0.5, "", ""],
    });

    // A rejected status (SpacetimeDB answers 530 with the reducer's reason): exit 1.
    reply = { code: 530, body: "Progress cannot go backwards" };
    const rejected = await status(["12", "processing", "--progress", "0.2"], env);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("Status rejected (530): Progress cannot go backwards");

    // The reducer rejects errors over 2000 UTF-16 units: send the traceback's tail.
    reply = { code: 200, body: "" };
    const traceback = "x".repeat(2500) + "END";
    expect((await status(["12", "failed", "--progress", "0.3", "--error", traceback], env)).code).toBe(0);
    const sent = received.at(-1)!.args[4] as string;
    expect(sent.length).toBe(2000);
    expect(sent.endsWith("xEND")).toBe(true);
    // Characters outside the BMP count twice in JavaScript, as in the reducer.
    await status(["12", "failed", "--progress", "0.3", "--error", "😀".repeat(1500)], env);
    expect((received.at(-1)!.args[4] as string).length).toBe(2000);

    // Bad arguments and missing settings: exit 2 without a request.
    const before = received.length;
    expect((await status(["12", "processing", "--progress", "nan"], env)).code).toBe(2);
    expect((await status(["12", "processing", "--progress", "1.5"], env)).code).toBe(2);
    const unset = await status(["12", "processing", "--progress", "0.5"], {
      STDB_HTTP_URL: env.STDB_HTTP_URL,
    });
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("STDB_DATABASE, PIPELINE_TOKEN");
    expect(received.length).toBe(before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Nothing listening: a clear message and exit 1.
  const down = await status(["12", "processing", "--progress", "0.5"], env);
  expect(down.code).toBe(1);
  expect(down.stderr).toContain("SpacetimeDB unreachable");
});

test.skipIf(!python)("source_check.py allows only upload keys under the asset base", async () => {
  const owner = "a".repeat(64),
    key = `videos/${owner}/00000000-0000-4000-8000-000000000001`,
    base = "https://assets.example.test";
  const check = async (url: string, from = base, who?: string) =>
    (await run([script("source_check.py"), url, from, ...(who ? [who] : [])])).code;
  expect(await check(`${base}/${key}.mp4`)).toBe(0);
  expect(await check(`${base}/${key}.mov`, `${base}/`, `0x${owner}`)).toBe(0);
  // upload:local's media route.
  const local = "http://127.0.0.1:5173/api/local-media";
  expect(await check(`${local}/${key}.webm`, `${local}/`)).toBe(0);
  for (const url of [
    `${base}/${key}.mp4?download=1`,
    `${base}/${key}.mp4#t=1`,
    `${base}/${key}.txt`,
    `${base}/videos/${owner}/../${key}.mp4`,
    `${base}/videos/%2e%2e/${key}.mp4`,
    `${base}.evil.test/${key}.mp4`,
    `https://evil.test@assets.example.test/${key}.mp4`,
    `http://assets.example.test/${key}.mp4`,
    `${base}:8443/${key}.mp4`,
    "http://169.254.169.254/latest/meta-data/",
    `http://127.0.0.1:5173/${key}.mp4`, // under the origin but not the media route
  ])
    expect(await check(url), url).toBe(1);
  // The key must name the memory's owner.
  expect(await check(`${base}/${key}.mp4`, base, "b".repeat(64))).toBe(1);
  // And it imports, for the worker.
  const imported = await run([
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../scripts", import.meta.url)))}); ` +
      `from source_check import allowed_source, MAX_SOURCE_BYTES; ` +
      `print(allowed_source(${JSON.stringify(`${base}/${key}.mp4`)}, ${JSON.stringify(base)}), MAX_SOURCE_BYTES)`,
  ]);
  expect(imported.stdout.trim()).toBe(`True ${2 * 1024 ** 3}`);
});
