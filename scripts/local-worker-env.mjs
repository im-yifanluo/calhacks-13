/** Write a private, sourceable environment for the existing worker. Never prints its token. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { databaseConfig } from "../server/upload/service.mjs";

const env = process.env;
const directory = resolve(env.LOCAL_UPLOAD_DIR || "data/uploads");
const output = resolve(process.argv[2] || "data/worker.local.env");
const worker = JSON.parse(await readFile(join(directory, ".worker-identity.json"), "utf8"));
const identity = String(worker.identity).replace(/^0x/, "").toLowerCase();
if (!/^[a-f0-9]{64}$/.test(identity) || typeof worker.token !== "string")
  throw new Error("Invalid local worker identity file");
if (env.PIPELINE_IDENTITY && env.PIPELINE_IDENTITY.toLowerCase() !== identity)
  throw new Error("PIPELINE_IDENTITY differs from the local worker. Use that worker's own credentials instead.");
const settings = {
  STDB_HTTP_URL: env.STDB_HTTP_URL || `http://127.0.0.1:${env.STDB_PORT || 3055}`,
  STDB_DATABASE: env.STDB_DATABASE || "memory-replay",
};
if (!(await databaseConfig(settings).verify(identity, `Bearer ${worker.token}`)))
  throw new Error("Local worker token is not valid for this SpacetimeDB server");
const origin = new URL(env.PUBLIC_ORIGIN || "http://127.0.0.1:5173").origin;
const values = {
  ...settings,
  PIPELINE_IDENTITY: identity,
  PIPELINE_TOKEN: worker.token,
  ASSET_BASE_URL: origin + "/api/local-media",
  MEMREPLAY_PUBLISH_DIR: resolve(env.LOCAL_SCENE_DIR || join(directory, "memories")),
  MEMREPLAY_PUBLIC_BASE_URL: origin + "/api/local-scenes",
};
const quote = (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
await mkdir(dirname(output), { recursive: true });
// Refuse to replace a credential file silently. Delete/choose another path deliberately.
await writeFile(
  output,
  Object.entries(values)
    .map(([key, value]) => `export ${key}=${quote(value)}\n`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Worker environment saved to ${output}. Keep it private; source it on the worker host. No GPU job was started.`,
);
