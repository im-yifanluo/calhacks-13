import { describe, expect, test } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { assetPath, inspectScene, localSceneSource, readSceneZip } from "../src/scenes/bundle";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const track = [
  { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] },
  { t: 2, p: [1, 1, 0], q: [0, 0, 0, 1] },
];
const manifest = () => ({
  version: 1,
  id: "fixture",
  title: "Moving camera",
  createdAt: "2026-10-24",
  source: { device: "test", width: 720, height: 1280, durationSec: 2, fps: 30, audioUrl: "audio.m4a" },
  world: { up: "+y", units: "meters", floorY: 0 },
  timeline: { durationSec: 2, sampleHz: 10 },
  background: { kind: "splat", url: "room.spz", format: "spz", splatCount: 1 },
  camera: { track, fovYDeg: 60 },
  objects: [],
});
const zip = (m = manifest(), extra = {}) =>
  new Blob([
    zipSync({
      "scene/memory.json": strToU8(JSON.stringify(m)),
      "scene/room.spz": new Uint8Array([1]),
      "scene/audio.m4a": new Uint8Array([2]),
      ...extra,
    }),
  ]);
describe("portable reconstructed scene package", () => {
  test("keeps the recorded timeline and resolves a Finder-style enclosing folder", async () => {
    const pkg = await readSceneZip(zip());
    const result = await inspectScene(pkg, pkg.manifests[0]);
    expect(result.manifest.timeline.durationSec).toBe(2);
    expect(result.manifest.camera.track).toEqual(track);
    expect(Object.keys(result.files).sort()).toEqual(["scene/audio.m4a", "scene/room.spz"]);
    const source = localSceneSource({ ...result, id: "test", importedAt: 0 });
    expect(await (await fetch(source.resolveAsset("audio.m4a"))).arrayBuffer()).toEqual(new Uint8Array([2]).buffer);
    expect(source.resolveAsset("room.spz")).toBe(source.resolveAsset("room.spz"));
    source.dispose();
  });
  test("rejects missing references instead of silently dropping time-series objects", async () => {
    const m = manifest();
    m.background.url = "missing.spz";
    const pkg = await readSceneZip(zip(m));
    await expect(inspectScene(pkg, pkg.manifests[0])).rejects.toThrow("scene/missing.spz");
  });
  test("invalid camera timestamps fail before storing the scene", async () => {
    const m = manifest();
    m.camera.track = [track[1], track[0]];
    const pkg = await readSceneZip(zip(m));
    await expect(inspectScene(pkg, pkg.manifests[0])).rejects.toThrow("timestamps");
  });
  test("ZIP traversal and external URLs are refused", async () => {
    await expect(readSceneZip(zip(manifest(), { "../evil.json": strToU8("{}") }))).rejects.toThrow("Unsafe");
    expect(() => assetPath("https://external.test/room.spz", "memory.json")).toThrow("relative");
    expect(() => assetPath("//external.test/room.spz", "memory.json")).toThrow("relative");
    expect(() => assetPath("%2e%2e%2fevil", "memory.json")).toThrow("Unsafe");
  });
  test("static alternative must be explicitly selected", async () => {
    const m = manifest();
    m.background.url = "missing.spz";
    const pkg = await readSceneZip(zip(m, { "scene/memory.static.json": strToU8(JSON.stringify(manifest())) }));
    expect(pkg.manifests[0]).toBe("scene/memory.json");
    await expect(inspectScene(pkg, pkg.manifests[0])).rejects.toThrow("Missing");
    expect((await inspectScene(pkg, "scene/memory.static.json")).title).toBe("Moving camera");
  });
  test("not a ZIP / lone splat gives a useful failure", async () => {
    await expect(readSceneZip(new Blob(["not a zip"]))).rejects.toThrow("standard");
    await expect(readSceneZip(new Blob([zipSync({ "room.spz": new Uint8Array([1]) })]))).rejects.toThrow(
      "No memory.json",
    );
  });
});

// Opt-in audit of private, real exports; files are not fixtures and never enter Git.
const fixtures = process.env.MEMOS_SCENE_FIXTURES;
test.skipIf(!fixtures)("all supplied scene folders: 3 full exports and 5 static alternatives", async () => {
  const expected: Record<string, boolean> = {
    img8013: true,
    img8014: true,
    img8015: true,
    img8016: false,
    img8017: false,
  };
  for (const [folder, complete] of Object.entries(expected)) {
    const root = join(fixtures!, folder),
      files: Record<string, Blob> = {};
    async function walk(dir: string) {
      for (const f of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) await walk(p);
        else files[p.slice(root.length + 1)] = new Blob([await readFile(p)]);
      }
    }
    await walk(root);
    const pkg = { files, manifests: ["memory.json", "memory.static.json"] };
    if (complete) expect((await inspectScene(pkg, "memory.json")).manifest.objects.length).toBeGreaterThan(0);
    else await expect(inspectScene(pkg, "memory.json")).rejects.toThrow("person-0.bin");
    expect((await inspectScene(pkg, "memory.static.json")).manifest.objects).toHaveLength(0);
  }
});
