import { unzip } from "fflate";
import { type Keyframe, type MemoryManifest, validateManifest, validateTrack } from "@memreplay/shared";

export const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 4000;
export type SceneFiles = Record<string, Blob>;
export interface ScenePackage {
  files: SceneFiles;
  manifests: string[];
}
export interface ImportedScene {
  id: string;
  title: string;
  importedAt: number;
  bytes: number;
  manifestPath: string;
  manifest: MemoryManifest;
  files: SceneFiles;
}
const ignored = (path: string) => path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
export function filePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    /[\\\x00-\x1f]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Unsafe file path: ${path}`);
  return path;
}
export function assetPath(ref: string, manifestPath: string): string {
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.includes("\\") || /[?#]/.test(ref))
    throw new Error(`Bundle assets must use relative file paths: ${ref}`);
  const url = new URL(ref, `https://bundle.invalid/${manifestPath.split("/").map(encodeURIComponent).join("/")}`);
  return filePath(decodeURIComponent(url.pathname.slice(1)));
}
function packageFiles(files: SceneFiles): ScenePackage {
  const paths = Object.keys(files);
  if (paths.length > MAX_FILES || paths.reduce((sum, p) => sum + files[p].size, 0) > MAX_BUNDLE_BYTES)
    throw new Error("Scene is too large. Use at most 250 MB and 4,000 files.");
  const manifests = paths
    .filter((p) => /(^|\/)memory(?:\.static)?\.json$/.test(p))
    .sort(
      (a, b) =>
        Number(a.endsWith("memory.static.json")) - Number(b.endsWith("memory.static.json")) || a.localeCompare(b),
    );
  if (!manifests.length)
    throw new Error("No memory.json found. Import the whole reconstructed scene folder, not just a splat or video.");
  return { files, manifests };
}
export async function readSceneZip(file: Blob): Promise<ScenePackage> {
  if (file.size > MAX_BUNDLE_BYTES) throw new Error("ZIP exceeds the 250 MB import limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let total = 0,
    count = 0,
    problem: Error | undefined;
  const seen = new Set<string>();
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      bytes,
      {
        filter: (entry) => {
          if (problem) return false;
          try {
            if (++count > MAX_FILES) throw new Error("ZIP contains more than 4,000 entries.");
            filePath(entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name);
            if (entry.name.endsWith("/") || ignored(entry.name)) return false;
            if (seen.has(entry.name)) throw new Error(`Duplicate file: ${entry.name}`);
            seen.add(entry.name);
            total += entry.originalSize;
            if (total > MAX_BUNDLE_BYTES) throw new Error("Expanded ZIP exceeds the 250 MB import limit.");
            return true;
          } catch (e) {
            problem = e as Error;
            return false;
          }
        },
      },
      (error, data) =>
        error
          ? reject(new Error("Could not read this ZIP. Export a standard, unencrypted ZIP archive."))
          : problem
            ? reject(problem)
            : resolve(data),
    );
  });
  const files: SceneFiles = Object.create(null);
  for (const [path, data] of Object.entries(entries)) files[path] = new Blob([data as Uint8Array<ArrayBuffer>]);
  return packageFiles(files);
}
export function readSceneFolder(selected: File[]): ScenePackage {
  const files: SceneFiles = Object.create(null);
  for (const file of selected) {
    const path = file.webkitRelativePath || file.name;
    filePath(path);
    if (ignored(path)) continue;
    if (files[path]) throw new Error(`Duplicate file: ${path}`);
    files[path] = file;
  }
  return packageFiles(files);
}
export async function inspectScene(
  pkg: ScenePackage,
  manifestPath: string,
): Promise<Omit<ImportedScene, "id" | "importedAt">> {
  const manifestFile = pkg.files[manifestPath];
  if (!manifestFile || manifestFile.size > 16 * 1024 * 1024)
    throw new Error("Missing manifest, or memory.json exceeds 16 MB.");
  let manifest: MemoryManifest;
  try {
    manifest = JSON.parse(await manifestFile.text());
  } catch {
    throw new Error("memory.json is not valid JSON.");
  }
  validateManifest(manifest);
  if (
    !manifest.source ||
    !Number.isFinite(manifest.source.width) ||
    manifest.source.width <= 0 ||
    !Number.isFinite(manifest.source.height) ||
    manifest.source.height <= 0
  )
    throw new Error("memory.json requires valid source dimensions.");
  if (manifest.background.splatCount > 1_000_000)
    throw new Error("Background exceeds the viewer’s 1,000,000-splat limit.");
  const files: SceneFiles = Object.create(null);
  const missing = new Set<string>();
  const include = (ref: string) => {
    const path = assetPath(ref, manifestPath),
      file = pkg.files[path];
    if (!file?.size) missing.add(path);
    else files[path] = file;
    return file;
  };
  const checkTrack = async (value: Keyframe[] | { url: string }, label: string) => {
    let frames: unknown = value;
    if (!Array.isArray(value)) {
      if (!value || typeof value.url !== "string") throw new Error(`${label}: missing track`);
      const file = include(value.url);
      if (!file) return;
      if (file.size > 16 * 1024 * 1024) throw new Error(`${label}: track exceeds 16 MB`);
      try {
        frames = JSON.parse(await file.text());
      } catch {
        throw new Error(`${label}: track is not JSON`);
      }
    }
    validateTrack(frames, label);
  };
  include(manifest.background.url);
  if (manifest.background.colliderUrl) include(manifest.background.colliderUrl);
  for (const ref of [manifest.source.audioUrl, manifest.source.videoUrl]) if (ref) include(ref);
  await checkTrack(manifest.camera.track, "Camera");
  for (const object of manifest.objects) {
    await checkTrack(object.track, object.label);
    if (object.collider.kind === "convex") include(object.collider.url);
    const visual = object.visual;
    if (visual.kind === "splat-sequence") {
      if (visual.frameCount > MAX_FILES) throw new Error("Splat sequence exceeds 4,000 frames.");
      for (let i = 0; i < visual.frameCount; i++) include(visual.urlPattern.replace("{frame}", String(i)));
    } else if (visual.kind !== "primitive") include(visual.url);
  }
  if (missing.size)
    throw new Error(
      `Missing ${missing.size} scene file(s): ${[...missing].slice(0, 6).join(", ")}. Include these files, or explicitly select memory.static.json for the static alternative.`,
    );
  // A GLB may hide additional URLs in its JSON chunk. Imported bundles require embedded resources.
  for (const [path, file] of Object.entries(files))
    if (path.toLowerCase().endsWith(".glb")) {
      const head = new DataView(await file.slice(0, 20).arrayBuffer());
      if (
        head.byteLength < 20 ||
        head.getUint32(0, true) !== 0x46546c67 ||
        head.getUint32(4, true) !== 2 ||
        head.getUint32(16, true) !== 0x4e4f534a
      )
        throw new Error(`${path}: expected a binary GLB v2 asset`);
      const length = head.getUint32(12, true);
      if (length > 16 * 1024 * 1024 || 20 + length > file.size) throw new Error(`${path}: invalid GLB JSON chunk`);
      const data = JSON.parse(await file.slice(20, 20 + length).text());
      for (const resource of [...(data.buffers ?? []), ...(data.images ?? [])]) {
        if (resource.uri && !resource.uri.startsWith("data:"))
          throw new Error(`${path}: use a self-contained GLB with embedded textures and buffers`);
      }
    }
  return {
    title: manifest.title,
    manifestPath,
    manifest,
    files,
    bytes: Object.values(files).reduce((n, f) => n + f.size, manifestFile.size),
  };
}

/** Only browser object URLs are returned; no local filenames or bytes are sent to SpacetimeDB. */
export function localSceneSource(scene: ImportedScene) {
  const urls = new Map<string, string>();
  return {
    manifest: scene.manifest,
    resolveAsset: (ref: string) => {
      const path = assetPath(ref, scene.manifestPath);
      if (!urls.has(path)) {
        const file = scene.files[path];
        if (!file) throw new Error(`Imported asset is missing: ${path}`);
        const type = path.endsWith(".m4a")
          ? "audio/mp4"
          : path.endsWith(".json")
            ? "application/json"
            : path.endsWith(".glb")
              ? "model/gltf-binary"
              : "application/octet-stream";
        urls.set(path, URL.createObjectURL(file.slice(0, file.size, type)));
      }
      return urls.get(path)!;
    },
    dispose: () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    },
  };
}
