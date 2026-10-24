// Viewer skeleton: one codebase for Quest 3S (WebXR) and phones (touch).
// Owners: P3 (rendering, physics, XR), P4 (networking, touch). See docs/PLAN.md section 2.3.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
import type { MemoryManifest, Keyframe } from "@memreplay/shared";

const params = new URLSearchParams(location.search);
const manifestUrl = params.get("memory") ?? "/mock/memory.json";
// Asset URLs inside memory.json may be relative to the manifest itself.
const manifestBase = new URL(manifestUrl, location.href);
const resolve = (u: string) => new URL(u, manifestBase).href;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Spark draws every SplatMesh through one SparkRenderer; nothing renders without it.
// maxStdDev sqrt(5) trims splat footprints for Quest frame rate (Spark default is sqrt(8)).
scene.add(new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) }));

// The camera lives in a rig. In VR the headset pose is applied relative to the rig,
// so moving the rig is how we put the viewer on the memory's floor at the wearer's start spot.
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 2);
rig.add(camera);

// Enter-VR button: reuse #vr in the HUD so Spark doesn't add its own big button over the scrubber.
// Spark shows it only where immersive VR is supported.
new SparkXr({ renderer, mode: "vr", elementId: "vr", enableHands: true, fixedFoveation: 1, referenceSpaceType: "local-floor" });

const controls = new OrbitControls(camera, renderer.domElement); // phone + desktop
controls.target.set(0, 1.2, 0);

let vrSpawn = { x: 0, y: 0, z: 2, yaw: 0 };
const desktopPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
renderer.xr.addEventListener("sessionstart", () => {
  desktopPose.pos.copy(camera.position);
  desktopPose.quat.copy(camera.quaternion);
  controls.enabled = false;
  rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z);
  rig.rotation.set(0, vrSpawn.yaw, 0);
});
renderer.xr.addEventListener("sessionend", () => {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  camera.position.copy(desktopPose.pos);
  camera.quaternion.copy(desktopPose.quat);
  controls.enabled = true;
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- timeline state (later: driven by the SpacetimeDB `timeline` row so everyone shares it) ---
let playhead = 0;
let playing = true;
let duration = 1;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
function sampleTrack(track: Keyframe[], t: number, out: THREE.Object3D) {
  if (track.length === 0) return;
  let i = 0;
  while (i < track.length - 2 && track[i + 1].t < t) i++;
  const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
  const k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  out.position.set(...a.p).lerp(_p.set(...b.p), k);
  out.quaternion.set(...a.q).slerp(_q.set(...b.q), k);
}

const dynamic: { obj: THREE.Object3D; track: Keyframe[]; from: number; to: number }[] = [];

async function loadTrack(track: Keyframe[] | { url: string }, id: string): Promise<Keyframe[]> {
  if (Array.isArray(track)) return track;
  try {
    return await (await fetch(resolve(track.url))).json();
  } catch (e) {
    console.error("track load failed", id, e);
    return [];
  }
}

async function load() {
  const m: MemoryManifest = await (await fetch(manifestUrl)).json();
  duration = m.timeline.durationSec;
  scene.add(new SplatMesh({ url: resolve(m.background.url) }));

  // VR spawn: the wearer's first head position, standing on the memory's floor, facing where they faced.
  const camTrack = await loadTrack(m.camera.track, "camera");
  const k0 = camTrack[0];
  const yaw = k0 ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...k0.q), "YXZ").y : 0;
  vrSpawn = { x: k0?.p[0] ?? 0, y: m.world.floorY, z: k0?.p[2] ?? 2, yaw };

  const tracks = await Promise.all(m.objects.map((o) => loadTrack(o.track, o.id)));
  m.objects.forEach((o, i) => {
    // Placeholder visuals: boxes until GLB/splat loading lands.
    const size = o.collider.kind === "box" ? o.collider.halfExtents.map((v) => v * 2) : [0.3, 0.3, 0.3];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshNormalMaterial({ wireframe: true }),
    );
    mesh.name = o.id;
    mesh.visible = false; // the loop applies visibleFrom/visibleTo
    scene.add(mesh);
    dynamic.push({ obj: mesh, track: tracks[i], from: o.visibleFrom, to: o.visibleTo });
  });
}

const playBtn = document.getElementById("play")!;
const scrub = document.getElementById("scrub") as HTMLInputElement;
const timeLabel = document.getElementById("time")!;
function setPlaying(v: boolean) {
  playing = v; // paused => physics mode (Rapier) takes over grabbed objects
  playBtn.textContent = playing ? "Pause" : "Play";
}
playBtn.onclick = () => setPlaying(!playing);
scrub.oninput = () => (playhead = (Number(scrub.value) / 1000) * duration);

// In VR the DOM HUD is invisible, so controllers drive the timeline:
// A or X toggles play/pause; while paused, a thumbstick left/right scrubs (2 s per second).
let prevToggle = false;
function pollXrInput(dt: number) {
  const session = renderer.xr.getSession();
  if (!session) return;
  let toggle = false;
  let stick = 0;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    if (gp.buttons[4]?.pressed) toggle = true;
    const x = gp.axes[2] ?? 0;
    if (Math.abs(x) > Math.abs(stick)) stick = x;
  }
  if (toggle && !prevToggle) setPlaying(!playing);
  prevToggle = toggle;
  if (!playing && Math.abs(stick) > 0.2) playhead = THREE.MathUtils.clamp(playhead + stick * 2 * dt, 0, duration);
}

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  pollXrInput(dt);
  if (playing) playhead = (playhead + dt) % duration;
  for (const d of dynamic) {
    d.obj.visible = playhead >= d.from && playhead <= d.to;
    sampleTrack(d.track, playhead, d.obj);
  }
  scrub.value = String(Math.round((playhead / duration) * 1000));
  timeLabel.textContent = `${playhead.toFixed(1)}s`;
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
});

load().catch((e) => console.error("failed to load memory", e));
