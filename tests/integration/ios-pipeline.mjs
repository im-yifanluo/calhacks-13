/** A fresh checkout's native app → API → DB → worker integration test (macOS/Xcode). */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error(
    "The native Swift acceptance test requires macOS and Xcode. Use npm run test:upload-api for the portable API checks.",
  );
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "memos-pipeline-test-"));
const binary = join(dir, "pipeline-upload");
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
try {
  await run("xcrun", [
    "swiftc",
    "-module-cache-path",
    join(dir, "module-cache"),
    "-parse-as-library",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
    ...["AccountKey", "CaptureRequirements", "Recorder", "SceneLibrary"].map(
      (name) => `apps/ios/SceneCapture/${name}.swift`,
    ),
    "apps/ios/Tests/PipelineUploadChecks.swift",
    "-o",
    binary,
  ]);
  await run(process.execPath, ["--import", "tsx", "tests/integration/upload-api.ts"], {
    ...process.env,
    UPLOAD_TEST_R2: "1",
    UPLOAD_TEST_SCENE_BIN: binary,
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}
