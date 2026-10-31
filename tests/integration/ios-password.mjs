/** Local HTTP regression for the real SceneLibrary sign-in/copy path. No cloud or GPU. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const work = await mkdtemp(join(tmpdir(), "memos-ios-password-"));
const binary = join(work, "password-checks");
function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: "inherit" });
    p.once("error", reject);
    p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}
try {
  await run("xcrun", [
    "swiftc",
    "-module-cache-path",
    join(work, "cache"),
    "-parse-as-library",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
    ...["AccountKey", "CaptureRequirements", "Recorder", "SceneLibrary"].map(
      (name) => `apps/ios/SceneCapture/${name}.swift`,
    ),
    "apps/ios/Tests/PasswordSignInChecks.swift",
    "-o",
    binary,
  ]);
  for (const scenario of ["password-only-config", "cached-config-upgrade", "unsupported"]) {
    let configReads = 0,
      shortLogins = 0;
    const destination = { server: "https://database.example", database: "native-password-test" };
    const credential = { ...destination, identity: "a".repeat(64), token: "header.payload.signature" };
    const account = {
      ...credential,
      displayName: "Native password test",
      provider: "key",
      password: "000007",
      personalKey: "memos1." + Buffer.from(JSON.stringify(credential)).toString("base64url"),
    };
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      const json = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path === "/api/account/config") {
        configReads++;
        const enabled = scenario !== "unsupported" && (scenario !== "cached-config-upgrade" || configReads > 1);
        return json(200, { ...destination, ...(enabled ? { passwordLength: 6 } : {}) });
      }
      if (path === "/api/account" && req.method === "POST") {
        let data = "";
        for await (const chunk of req) data += chunk;
        const body = JSON.parse(data);
        if (body.password !== account.password || Object.keys(body).length !== 1 || req.headers.authorization)
          return json(400, { error: "Expected only the six-digit password string, without Authorization" });
        shortLogins++;
        return json(200, account);
      }
      if (![account.personalKey, credential.token].some((token) => req.headers.authorization === `Bearer ${token}`))
        return json(401, { error: "Invalid session credential" });
      if (path === "/api/account" || path === "/api/profile")
        return json(200, { identity: account.identity, displayName: account.displayName, provider: "key" });
      if (path === "/api/memories")
        return json(200, {
          memories: [
            {
              id: "42",
              title: "Existing recording",
              sourceUrl: "https://assets.example/test.mp4",
              status: "uploaded",
              durationUs: "1000000",
              requestId: "old-recording",
            },
          ],
        });
      return json(404, { error: "Unexpected route" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const file = join(work, "fixture.json");
      await writeFile(file, JSON.stringify({ account }), { mode: 0o600 });
      await run(binary, [
        "--api",
        `http://127.0.0.1:${server.address().port}`,
        "--account-file",
        file,
        ...(scenario === "unsupported" ? ["--unsupported"] : []),
      ]);
      assert.ok(configReads >= 2, "Sign-in must refresh cached server capabilities");
      assert.equal(shortLogins, scenario === "unsupported" ? 0 : 2);
      console.log(`PASS ${scenario}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
