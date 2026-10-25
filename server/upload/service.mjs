import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { connectionConfig } from "./connections.mjs";
import { makeHandler, databaseConfig } from "./core.mjs";
import { passwordVault } from './passwords.mjs';
import { s3PasswordStore } from './passwords-s3.mjs';
export { ticket, readTicket, metadata, makeHandler, databaseConfig } from "./core.mjs";

export function productionConfig(env = process.env) {
  for (const name of [
    "S3_BUCKET",
    "ASSET_BASE_URL",
    "UPLOAD_SIGNING_SECRET",
    "PIPELINE_IDENTITY",
    "STDB_HTTP_URL",
    "STDB_DATABASE",
  ])
    if (!env[name]) throw new Error(`${name} is required`);
  if (env.UPLOAD_SIGNING_SECRET.length < 32)
    throw new Error("UPLOAD_SIGNING_SECRET needs 32+ characters");
  if (!/^[a-f0-9]{64}$/i.test(env.PIPELINE_IDENTITY))
    throw new Error("PIPELINE_IDENTITY must be a 64-character hex identity");
  for (const name of ["ASSET_BASE_URL", "S3_ENDPOINT"]) {
    if (!env[name]) continue;
    const value = new URL(env[name]);
    if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash)
      throw new Error(`${name} must be an HTTP(S) URL without credentials or query parameters`);
  }
  const s3 = new S3Client({
    // The browser supplies the body later. Do not sign a checksum of an empty body.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            sessionToken: env.AWS_SESSION_TOKEN,
          }
        : undefined,
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION || "auto",
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  });
  const database = databaseConfig(env);
  return {
    secret: env.UPLOAD_SIGNING_SECRET,
    assetBase: env.ASSET_BASE_URL,
    pipelineIdentity: env.PIPELINE_IDENTITY,
    allowedOrigins: (
      env.UPLOAD_ALLOWED_ORIGINS || "https://localhost:5173"
    ).split(",").map(value => value.trim()).filter(Boolean),
    ...database,
    passwords: passwordVault({ store: s3PasswordStore(s3, env.ACCOUNT_PASSWORD_BUCKET || env.S3_BUCKET),
      secret: env.UPLOAD_SIGNING_SECRET, settings: database.accountConfig }),
    connections: connectionConfig(env, {
      backend: "s3", assetBaseUrl: env.ASSET_BASE_URL,
      scenePrefix: "memories/<memoryId>-<requestId>/", writeScene: "memreplay publish <work-dir> --to s3",
    }),
    sign: async (d) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: d.key,
          ContentType: d.type,
          ContentLength: d.size,
        }),
        // The presigner leaves Content-Type unsigned by default. Signed, storage refuses a
        // PUT of any other type to this key, which is later served at a public URL.
        { expiresIn: 900, signableHeaders: new Set(["content-type"]) },
      ),
    head: async (key) => {
      try {
        const result = await s3.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
        );
        return { size: result.ContentLength, type: result.ContentType };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404)
          throw new Error("Upload not found; PUT the video first");
        throw error;
      }
    },
  };
}


if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createServer(makeHandler(productionConfig()));
  server.requestTimeout = 30000;
  server.listen(
    Number(process.env.UPLOAD_PORT || 8788),
    process.env.UPLOAD_HOST || "127.0.0.1",
    () => console.log("Upload signing service ready"),
  );
}
