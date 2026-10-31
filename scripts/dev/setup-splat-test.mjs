// Reproduce the local public-splat fixtures without committing binary assets.
// Run from any directory: node scripts/dev/setup-splat-test.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const directory = new URL("../../apps/web/public/splat-test/", import.meta.url);
const source = "https://sparkjs.dev/assets/splats/butterfly.spz";
const expectedHash = "2e22c9967731bebc0ea74e1747cd42e955dec16a89dba9aac07d62a6c5780e0d";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(directory, { recursive: true });
await writeFile(new URL(".gitignore", directory), "*\n");
let asset;
try {
  asset = await readFile(new URL("butterfly.spz", directory));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!asset || hash(asset) !== expectedHash) {
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Sample download failed: HTTP ${response.status}`);
  asset = Buffer.from(await response.arrayBuffer());
  if (hash(asset) !== expectedHash)
    throw new Error("Public sample changed. Review it before updating the expected SHA-256.");
  await writeFile(new URL("butterfly.spz", directory), asset);
}

const fields = [
  "x",
  "y",
  "z",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3",
];
const header = Buffer.from(
  `ply\nformat binary_little_endian 1.0\nelement vertex 961\n${fields.map((f) => `property float ${f}\n`).join("")}end_header\n`,
);
const points = Buffer.alloc(961 * 14 * 4);
let offset = 0;
for (let x = -15; x <= 15; x++)
  for (let z = -15; z <= 15; z++) {
    const values = [
      x * 0.2,
      -0.02,
      z * 0.2,
      -1.2,
      -0.7,
      -0.6,
      1.5,
      Math.log(0.04),
      Math.log(0.005),
      Math.log(0.04),
      1,
      0,
      0,
      0,
    ];
    for (const value of values) {
      points.writeFloatLE(value, offset);
      offset += 4;
    }
  }
await writeFile(new URL("floor.ply", directory), Buffer.concat([header, points]));

const rendering = {
  version: 1,
  id: "public-splat-render-test",
  title: "Public Gaussian splat test \u00b7 Spark butterfly",
  createdAt: "2026-10-23T22:00:00-07:00",
  source: {
    device: "public-Spark-sample-not-team-footage",
    durationSec: 30,
    fps: 30,
    width: 1,
    height: 1,
  },
  world: {
    up: "+y",
    units: "meters",
    floorY: 0,
  },
  timeline: {
    durationSec: 30,
    sampleHz: 30,
  },
  background: {
    kind: "splat",
    url: "./floor.ply",
    format: "ply",
    splatCount: 961,
  },
  camera: {
    track: [
      {
        t: 0,
        p: [0, 1.6, 2],
        q: [0, 0, 0, 1],
      },
    ],
    fovYDeg: 65,
  },
  objects: [
    {
      id: "butterfly",
      label: "public splat sample",
      visual: {
        kind: "splat",
        url: "./butterfly.spz",
        format: "spz",
      },
      collider: {
        kind: "box",
        halfExtents: [1, 1, 0.3],
      },
      mass: 0.4,
      grabbable: false,
      visibleFrom: 0,
      visibleTo: 30,
      track: [
        {
          t: 0,
          p: [0, 1.2, -1],
          q: [1, 0, 0, 0],
          s: 0.7,
        },
        {
          t: 30,
          p: [0, 1.2, -1],
          q: [1, 0, 0, 0],
          s: 0.7,
        },
      ],
    },
  ],
};
const interaction = structuredClone(rendering);
interaction.id = "public-splat-interaction-test";
interaction.title = "Public splat · pause, grab, and throw";
interaction.objects[0].grabbable = true;
const two = structuredClone(rendering);
two.id = "public-splat-two-object-test";
two.title = "Two public splats · 354k plus floor";
for (const frame of two.objects[0].track) frame.p = [-0.75, 1.2, -1];
const second = structuredClone(two.objects[0]);
second.id = "butterfly-2";
for (const frame of second.track) frame.p = [0.75, 1.2, -1];
two.objects.push(second);
for (const [name, manifest] of Object.entries({ rendering, interaction, "two-splats": two })) {
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify(manifest, null, 2) + "\n");
}
console.log("Splat fixtures ready. Start npm run dev, then open:");
console.log("http://localhost:5173/?memory=/splat-test/rendering.json");
console.log("http://localhost:5173/?memory=/splat-test/two-splats.json");
console.log("http://localhost:5173/?memory=/splat-test/interaction.json");
console.log("Source/credits: https://github.com/sparkjsdev/assets");
