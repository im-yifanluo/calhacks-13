import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SplatMesh } from "@sparkjsdev/spark";
import type { MemoryManifest, Keyframe } from "@memreplay/shared";
import { Multiplayer } from "./net";
import { branchFrames } from "./net/replay";
import { PhysicsBridge, type Interactable } from "./net/physics-bridge";
import { TouchInput } from "./input-touch";
import { uploadPanel } from "./upload";
import "./style.css";

const params = new URLSearchParams(location.search),
  demo = params.get("demo") === "1";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const net = new Multiplayer();
net.connect();
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
const scene = new THREE.Scene();
scene.background = new THREE.Color("#101720");
const camera = new THREE.PerspectiveCamera(
  70,
  innerWidth / innerHeight,
  0.05,
  200,
);
camera.position.set(0, 1.6, 2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xd6eaff, 0x263445, 3));
scene.add(new THREE.GridHelper(20, 40, 0x42616c, 0x243641));
const content = new THREE.Group();
scene.add(content);
let objects: Interactable[] = [],
  tracks = new Map<string, Keyframe[]>(),
  duration = 6,
  playhead = 0,
  playing = true,
  loaded = "",
  generation = 0,
  physics: PhysicsBridge | undefined;
const avatars = new Map<string, THREE.Mesh>();
function sample(track: Keyframe[], t: number, out: THREE.Object3D) {
  if (!track.length) return;
  let i = 0;
  while (i < track.length - 2 && track[i + 1].t < t) i++;
  const a = track[i],
    b = track[Math.min(i + 1, track.length - 1)],
    k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  out.position.set(...a.p).lerp(new THREE.Vector3(...b.p), k);
  out.quaternion
    .set(...a.q)
    .slerp(new THREE.Quaternion(...b.q), k)
    .normalize();
}
function assetUrl(path: string, manifest: string) {
  return new URL(path, new URL(manifest, location.href)).href;
}
async function load(url: string) {
  const current = ++generation;
  try {
    $("scene-status").textContent = "Loading memory…";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
    const m: MemoryManifest = await response.json();
    if (
      m.version !== 1 ||
      m.world?.up !== "+y" ||
      m.world?.units !== "meters" ||
      !Array.isArray(m.objects) ||
      !(m.timeline?.durationSec > 0)
    )
      throw new Error("Invalid memory.json contract");
    const nextTracks = new Map<string, Keyframe[]>();
    for (const o of m.objects) {
      const track = Array.isArray(o.track)
        ? o.track
        : await (await fetch(assetUrl(o.track.url, url))).json();
      nextTracks.set(o.id, track);
    }
    if (current !== generation) return;
    const nextPhysics = await PhysicsBridge.create(net, m.world.floorY);
    if (current !== generation) {
      nextPhysics.dispose();
      return;
    }
    physics?.dispose();
    physics = nextPhysics;
    content.clear();
    objects = [];
    tracks = nextTracks;
    duration = m.timeline.durationSec;
    if (!demo) {
      const bg = new SplatMesh({ url: assetUrl(m.background.url, url) });
      content.add(bg);
    }
    for (const o of m.objects) {
      // Preserve the scaffold's debug geometry. P3 owns the production GLB/splat loader.
      const c = o.collider;
      const geometry =
        c.kind === "sphere"
          ? new THREE.SphereGeometry(c.radius, 24, 16)
          : c.kind === "box"
            ? new THREE.BoxGeometry(
                ...(c.halfExtents.map((n) => n * 2) as [
                  number,
                  number,
                  number,
                ]),
              )
            : new THREE.BoxGeometry(0.3, 0.3, 0.3);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0x6ee7c4, roughness: 0.45 }),
      );
      mesh.name = o.id;
      content.add(mesh);
      objects.push({ mesh, definition: o });
    }
    $("scene-title").textContent = m.title;
    $("scene-status").textContent = demo
      ? "Demo geometry · multiplayer and phone controls"
      : "Object debug geometry · P3 connects production assets";
  } catch (error) {
    net.report(error);
    $("scene-status").textContent = "Memory could not be loaded";
    loaded = "";
  }
}
let touch = new TouchInput(
  renderer.domElement,
  camera,
  controls,
  () =>
    objects
      .filter((o) => o.definition.grabbable && o.mesh.visible)
      .map((o) => o.mesh),
  {
    paused: () => Boolean(net.timeline?.paused),
    grab: async (id) => {
      const o = objects.find((o) => o.definition.id === id);
      return Boolean(o && (await physics?.grab(o)));
    },
    move: (id, p) => physics?.move(id, p),
    drop: (id, v) => {
      void physics?.drop(id, v);
    },
  },
  $("joystick"),
);
const name = $<HTMLInputElement>("player-name");
name.value = localStorage.getItem("memreplay-name") || "Guest";
const device = () =>
  renderer.xr.isPresenting
    ? "quest"
    : matchMedia("(pointer:coarse)").matches
      ? "phone"
      : "desktop";
const who = () => {
  localStorage.setItem("memreplay-name", name.value);
  return { name: name.value || "Guest", device: device() };
};
$("create-room").onclick = () => {
  const value = $<HTMLSelectElement>("memories").value;
  if (value)
    void net.run(() =>
      net.connection!.reducers.createRoom({
        memoryId: BigInt(value),
        ...who(),
      }),
    );
};
$("join-room").onclick = () => {
  void net.run(() =>
    net.connection!.reducers.joinRoom({
      joinCode: $<HTMLInputElement>("join-code").value,
      ...who(),
    }),
  );
};
$("leave-room").onclick = () => {
  void net.run(() => net.connection!.reducers.leaveRoom({}));
};
$("copy-link").onclick = async () => {
  if (net.room) {
    const url = new URL(location.href);
    url.searchParams.set("room", net.room.joinCode);
    url.pathname = "/";
    try {
      await navigator.clipboard.writeText(url.href);
      $("scene-status").textContent = "Room link copied";
    } catch {
      $("scene-status").textContent = url.href;
    }
  }
};
$("play").onclick = () => {
  if (net.timeline)
    void net.run(() =>
      net.connection!.reducers.setPaused({ paused: !net.timeline!.paused }),
    );
  else {
    playing = !playing;
  }
};
$<HTMLInputElement>("scrub").onchange = () => {
  const t = (Number($<HTMLInputElement>("scrub").value) / 1000) * duration;
  if (net.room)
    void net.run(() =>
      net.connection!.reducers.seek({ mediaUs: BigInt(Math.round(t * 1e6)) }),
    );
  else playhead = t;
};
$("fork").onclick = () => {
  void net.run(() =>
    net.connection!.reducers.forkBranch({
      name: `Branch ${net.branches.length + 1}`,
    }),
  );
};
$<HTMLSelectElement>("branches").onchange = () => {
  void net.run(() =>
    net.connection!.reducers.setBranch({
      branchId: BigInt($<HTMLSelectElement>("branches").value),
    }),
  );
};
$("register-memory").onclick = async () => {
  const manifestUrl = new URL(
    $<HTMLInputElement>("manifest-url").value || "/mock/memory.json",
    location.href,
  ).href;
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error("Manifest not found");
    const m: MemoryManifest = await response.json();
    if (
      m.version !== 1 ||
      !m.title ||
      !Number.isFinite(m.timeline?.durationSec) ||
      m.timeline.durationSec <= 0
    )
      throw new Error("Invalid manifest");
    await net.run(() =>
      net.connection!.reducers.createMemory({
        requestId: crypto.randomUUID(),
        title: m.title,
        sourceUrl: "",
        manifestUrl,
        pipelineIdentity: net.identity!,
        durationUs: BigInt(Math.round(m.timeline.durationSec * 1e6)),
      }),
    );
  } catch (error) {
    net.report(error);
  }
};
const upload = $("upload-panel");
uploadPanel(net, upload);
$("toggle-upload").onclick = () => {
  upload.hidden = !upload.hidden;
};
if (location.pathname === "/upload") upload.hidden = false;
let joinedFromURL = false,
  memoryOptions = "",
  branchOptions = "";
net.addEventListener("change", () => {
  $("connection").textContent = net.status;
  $("error").textContent = net.error;
  const select = $<HTMLSelectElement>("memories"),
    selected = select.value;
  const memoryKey = net.memories
    .map((m) => `${m.id}:${m.title}:${m.status}:${m.progress}`)
    .join("|");
  if (memoryKey !== memoryOptions) {
    memoryOptions = memoryKey;
    select.replaceChildren();
    for (const m of net.memories) {
      const option = new Option(
        `${m.title} · ${m.status} ${Math.round(m.progress * 100)}%`,
        m.id.toString(),
      );
      option.disabled = m.status !== "ready";
      select.add(option);
    }
    if (Array.from(select.options).some((o) => o.value === selected))
      select.value = selected;
  }
  $("room-label").textContent = net.room
    ? `Room ${net.room.joinCode} · ${net.players.length} present`
    : "Explore solo or join a room";
  $("people").textContent = net.players
    .map((p) => `${p.name} (${p.device})`)
    .join(" · ");
  const failure = net.memories
    .filter((m) => m.error)
    .map((m) => `${m.title}: ${m.error}`)
    .join("\n");
  $("pipeline-errors").textContent = failure;
  const branches = $<HTMLSelectElement>("branches");
  const branchKey = net.branches
    .map((b) => `${b.id}:${b.name}:${b.forkMediaUs}`)
    .join("|");
  if (branchKey !== branchOptions) {
    branchOptions = branchKey;
    branches.replaceChildren(new Option("Original", "0"));
    for (const b of net.branches)
      branches.add(
        new Option(
          `${b.name} · ${(Number(b.forkMediaUs) / 1e6).toFixed(1)}s`,
          b.id.toString(),
        ),
      );
  }
  branches.value = (net.timeline?.branchId ?? 0n).toString();
  $<HTMLButtonElement>("fork").disabled = !net.timeline?.paused;
  $<HTMLButtonElement>("create-room").disabled = !net.ready || !select.value;
  $<HTMLButtonElement>("join-room").disabled = !net.ready;
  $<HTMLButtonElement>("register-memory").disabled = !net.ready;
  if (net.ready && params.has("room") && !joinedFromURL) {
    joinedFromURL = true;
    void net.run(() =>
      net.connection!.reducers.joinRoom({
        joinCode: params.get("room")!,
        ...who(),
      }),
    );
  }
  const target = net.memory?.manifestUrl;
  if (target && target !== loaded) {
    loaded = target;
    void load(target);
  }
});
loaded = params.get("memory") || "/mock/memory.json";
void load(loaded);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (net.timeline) {
    playhead = net.time();
    playing = !net.timeline.paused;
  } else if (playing) playhead = (playhead + dt) % duration;
  physics?.update(dt);
  for (const o of objects) {
    const id = o.definition.id;
    o.mesh.visible =
      playhead >= o.definition.visibleFrom &&
      playhead <= o.definition.visibleTo;
    if (physics?.owns(id)) continue;
    const state = net.objects.find((s) => s.objectId === id);
    if (
      state &&
      (state.simOwner ||
        (net.timeline?.paused &&
          state.updatedAt.microsSinceUnixEpoch >=
            net.timeline.anchorServerTs.microsSinceUnixEpoch &&
          playhead >= Number(state.fromMediaUs) / 1e6))
    ) {
      o.mesh.position.lerp(
        new THREE.Vector3(state.px, state.py, state.pz),
        Math.min(1, dt * 15),
      );
      o.mesh.quaternion.slerp(
        new THREE.Quaternion(state.qx, state.qy, state.qz, state.qw),
        Math.min(1, dt * 15),
      );
      continue;
    }
    const replay = branchFrames(
      net.timeline?.branchId ?? 0n,
      id,
      playhead,
      net.branches,
      net.chunks,
    );
    if (replay) sample(replay.frames, replay.time, o.mesh);
    else if (state && playhead >= Number(state.fromMediaUs) / 1e6) {
      o.mesh.position.set(state.px, state.py, state.pz);
      o.mesh.quaternion.set(state.qx, state.qy, state.qz, state.qw);
    } else sample(tracks.get(id) || [], playhead, o.mesh);
  }
  const currentPlayers = new Set<string>();
  for (const p of net.players) {
    if (p.identity.isEqual(net.identity!)) continue;
    const id = p.identity.toHexString();
    currentPlayers.add(id);
    let mesh = avatars.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 12, 8),
        new THREE.MeshBasicMaterial({ color: p.color }),
      );
      avatars.set(id, mesh);
      scene.add(mesh);
    }
    mesh.position.lerp(
      new THREE.Vector3(p.hx, p.hy, p.hz),
      Math.min(1, dt * 12),
    );
    mesh.quaternion.slerp(
      new THREE.Quaternion(p.hqx, p.hqy, p.hqz, p.hqw),
      Math.min(1, dt * 12),
    );
  }
  for (const [id, mesh] of avatars)
    if (!currentPlayers.has(id)) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      avatars.delete(id);
    }
  const headCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  const p = headCamera.getWorldPosition(new THREE.Vector3()),
    q = headCamera.getWorldQuaternion(new THREE.Quaternion());
  const left = renderer.xr.isPresenting
    ? renderer.xr.getController(0).getWorldPosition(new THREE.Vector3())
    : p;
  const right = renderer.xr.isPresenting
    ? renderer.xr.getController(1).getWorldPosition(new THREE.Vector3())
    : p;
  net.sendPose({
    hx: p.x,
    hy: p.y,
    hz: p.z,
    hqx: q.x,
    hqy: q.y,
    hqz: q.z,
    hqw: q.w,
    lx: left.x,
    ly: left.y,
    lz: left.z,
    rx: right.x,
    ry: right.y,
    rz: right.z,
  });
  if (document.activeElement !== $("scrub"))
    $<HTMLInputElement>("scrub").value = String(
      Math.round((playhead / duration) * 1000),
    );
  $("time").textContent = `${playhead.toFixed(1)} / ${duration.toFixed(1)}s`;
  $("play").textContent = playing ? "Pause" : "Play";
  if (!renderer.xr.isPresenting) {
    touch.update(dt);
    controls.update();
  }
  renderer.render(scene, camera);
});
