/** Read-only local equivalent of the worker's public scene bucket. No upload API. */
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";

const types = {
  ".json": "application/json",
  ".ply": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".m4a": "audio/mp4",
};
export async function sceneStorage(directory) {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/local-scenes/")) return false;
    const error = (code, message) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return true;
    };
    if (!["GET", "HEAD"].includes(req.method)) return error(405, "Scene files are read-only");
    try {
      const key = decodeURIComponent(url.pathname.slice("/api/local-scenes/".length));
      const parts = key.split("/");
      // Match the worker's <memory ID>-<request UUID> directory and ordinary relative assets.
      if (
        !/^[1-9][0-9]*(?:-[a-f0-9-]{36})?$/i.test(parts[0]) ||
        parts.length < 2 ||
        parts.some((p) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(p)) ||
        !types[extname(key)]
      )
        return error(404, "Scene file not found");
      const file = await realpath(resolve(root, key));
      if (!file.startsWith(root + sep)) return error(404, "Scene file not found");
      const info = await stat(file);
      if (!info.isFile() || !info.size) return error(404, "Scene file not found");
      let start = 0,
        end = info.size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range) return error(416, "Unsupported range");
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= info.size) return error(416, "Range outside file");
      }
      res.writeHead(req.headers.range ? 206 : 200, {
        "Content-Type": types[extname(key)],
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(req.headers.range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      });
      if (req.method === "HEAD") res.end();
      else
        createReadStream(file, { start, end })
          .on("error", () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) return error(404, "Scene file not found");
      res.destroy();
    }
    return true;
  };
}
