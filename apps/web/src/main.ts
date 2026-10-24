// Viewer skeleton: one codebase for Quest 3S (WebXR) and phones (touch).
// Owners: client team. See docs/PLAN.md "Client" for the build order.
import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SplatMesh } from "@sparkjsdev/spark";
import type { MemoryManifest, Keyframe } from "@memreplay/shared";

const params = new URLSearchParams(location.search);
const manifestUrl = params.get("memory") ?? "/mock/memory.json";

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 2);
const controls = new OrbitControls(camera, renderer.domElement); // phone + desktop
controls.target.set(0, 1.2, 0);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- timeline state (later: driven by SpacetimeDB `room` row so everyone shares it) ---
let playhead = 0;
let playing = true;
let duration = 1;

function sampleTrack(track: Keyframe[], t: number, out: THREE.Object3D) {
  if (track.length === 0) return;
  let i = 0;
  while (i < track.length - 2 && track[i + 1].t < t) i++;
  const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
  const k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  out.position.set(...a.p).lerp(new THREE.Vector3(...b.p), k);
  out.quaternion.set(...a.q).slerp(new THREE.Quaternion(...b.q), k);
}

const dynamic: { obj: THREE.Object3D; track: Keyframe[]; from: number; to: number }[] = [];

async function load() {
  const m: MemoryManifest = await (await fetch(manifestUrl)).json();
  duration = m.timeline.durationSec;
  const bg = new SplatMesh({ url: m.background.url });
  scene.add(bg);
  for (const o of m.objects) {
    // Placeholder visuals: boxes until GLB/splat loading lands.
    const size = o.collider.kind === "box" ? o.collider.halfExtents.map((v) => v * 2) : [0.3, 0.3, 0.3];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshNormalMaterial({ wireframe: true }),
    );
    mesh.name = o.id;
    scene.add(mesh);
    if (Array.isArray(o.track)) dynamic.push({ obj: mesh, track: o.track, from: o.visibleFrom, to: o.visibleTo });
  }
}

const playBtn = document.getElementById("play")!;
const scrub = document.getElementById("scrub") as HTMLInputElement;
const timeLabel = document.getElementById("time")!;
playBtn.onclick = () => {
  playing = !playing; // paused => physics mode (Rapier) takes over grabbed objects
  playBtn.textContent = playing ? "Pause" : "Play";
};
scrub.oninput = () => (playhead = (Number(scrub.value) / 1000) * duration);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (playing) playhead = (playhead + dt) % duration;
  for (const d of dynamic) {
    d.obj.visible = playhead >= d.from && playhead <= d.to;
    sampleTrack(d.track, playhead, d.obj);
  }
  scrub.value = String(Math.round((playhead / duration) * 1000));
  timeLabel.textContent = `${playhead.toFixed(1)}s`;
  controls.update();
  renderer.render(scene, camera);
});

load().catch((e) => console.error("failed to load memory", e));
