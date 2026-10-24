import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { loadMemory } from "./loader.js";
import { initPhysics } from "./physics.js";
import { Viewer } from "./viewer.js";
import { XRInput } from "./input-xr.js";
import { desktopInput } from "./input-desktop.js";
import { sampleTrack } from "./tracks.js";
import { mountAudio } from "./audio.js";
import { Session } from "./session.js";
import { PhoneJoystick, isTouchDevice } from "./phone-joystick.js";
import "./style.css";

declare global { interface Window { memoryReplay?: Viewer; __memreplay?: unknown } }
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status"), loading = element("loading"), warning = element("warning");
const play = element<HTMLButtonElement>("play"), scrub = element<HTMLInputElement>("scrub");
const branches = element<HTMLSelectElement>("branches"), debug = element<HTMLInputElement>("debug");
const eyes = element<HTMLInputElement>("eyes");
let viewer: Viewer | undefined;
const showWarning = (message: string) => { warning.hidden = false; warning.textContent = message; };

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const manifestUrl = params.get("memory") ?? "/mock/memory.json";
  const demo = !params.has("memory");
  const xrPreview = import.meta.env.DEV && params.has("xrPreview");
  document.body.classList.toggle("xr-preview", xrPreview);
  element("xr-preview-note").hidden = !xrPreview;
  element("mode").textContent = demo ? "Demo" : "Recording";
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  const stage = element("stage");
  renderer.setPixelRatio(1); renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType("local-floor"); renderer.xr.setFoveation(1);
  renderer.domElement.setAttribute("aria-label", "Interactive 3D memory. Pause, then drag an object to throw it.");
  stage.appendChild(renderer.domElement);
  const vrEntry = element("vr-entry");
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202320);
  scene.add(new THREE.HemisphereLight(0xbfeaf4, 0x374454, 2.5));
  const light = new THREE.DirectionalLight(0xffd7b5, 3); light.position.set(3, 5, 2); scene.add(light);
  const camera = new THREE.PerspectiveCamera(65, stage.clientWidth / stage.clientHeight, 0.05, 200);
  camera.position.set(2.5, 2.1, 3.5);
  if (demo && innerWidth < 650) camera.position.set(1.3, 1.7, 1.2);
  const rig = new THREE.Group(); scene.add(rig); rig.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, -1); controls.enableDamping = true; controls.maxDistance = 20; controls.minDistance = 0.4;
  controls.maxPolarAngle = Math.PI * 0.49;
  if (xrPreview) {
    camera.position.set(0, 1.65, 2); controls.target.set(0, 1.65, -1); controls.update(); controls.enabled = false;
  }
  const spark = new SparkRenderer({ renderer, preUpdate: false, maxStdDev: Math.sqrt(5), lodSplatCount: 500_000 });
  scene.add(spark);
  // Shared rooms (session.ts) connect while the memory loads. Without a room the viewer stays local.
  const session = new Session({ renderer, scene, camera, manifestUrl, showStatus: message => { status.textContent = message; } });
  addEventListener("pagehide", () => session.dispose(), { once: true });
  const joystick = new PhoneJoystick(element("joystick"), camera, controls);
  document.body.classList.toggle("touch", isTouchDevice());
  const hud = element("hud");
  const hudSpace = () => document.documentElement.style.setProperty("--hud-space", `${Math.max(0, Math.round(document.body.clientHeight - hud.getBoundingClientRect().top))}px`);
  new ResizeObserver(hudSpace).observe(hud); addEventListener("resize", hudSpace); hudSpace();
  const resizeScene = () => {
    if (renderer.xr.isPresenting) return;
    const { width, height } = stage.getBoundingClientRect();
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix(); renderer.setSize(width, Math.max(1, height));
  };
  const stageObserver = new ResizeObserver(resizeScene);
  stageObserver.observe(stage);
  const savedCamera = new THREE.Vector3(), savedTarget = new THREE.Vector3();
  // Keep main's corrected spawn: start at the wearer's horizontal position on the scene floor.
  let vrSpawn = { x: 0, y: 0, z: 2, yaw: 0 };
  renderer.xr.addEventListener("sessionstart", () => {
    savedCamera.copy(camera.position); savedTarget.copy(controls.target); controls.enabled = false;
    rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z); rig.rotation.set(0, vrSpawn.yaw, 0);
    eyes.checked = false; eyes.disabled = true; document.body.classList.add("in-xr");
  });
  renderer.xr.addEventListener("sessionend", () => {
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); camera.position.copy(savedCamera);
    controls.target.copy(savedTarget); controls.enabled = true; eyes.disabled = false; document.body.classList.remove("in-xr");
    resizeScene();
  });
  renderer.domElement.addEventListener("webglcontextlost", event => {
    event.preventDefault(); renderer.setAnimationLoop(null); status.textContent = "Graphics context lost. Reload to recover.";
    element("reload").hidden = false;
  });
  await initPhysics();
  const memory = await loadMemory(manifestUrl, demo, showWarning);
  const firstPose = memory.cameraTrack[0];
  vrSpawn = { x: firstPose.p[0], y: memory.manifest.world.floorY, z: firstPose.p[2],
    yaw: new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...firstPose.q).normalize(), "YXZ").y };
  if (renderer.xr.isPresenting) { rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z); rig.rotation.set(0, vrSpawn.yaw, 0); }
  scene.add(memory.root);
  const grid = new THREE.GridHelper(10, 20, 0x666e5c, 0x343b30); grid.position.y = memory.manifest.world.floorY; scene.add(grid);
  viewer = new Viewer(memory, message => { status.textContent = message; }); window.memoryReplay = viewer;
  const currentViewer = viewer;
  element("title").textContent = demo ? "Practice room" : memory.manifest.title;
  element("subtitle").textContent = "Explore the scene. Make a different take.";
  element("asset-info").textContent = `${memory.objects.length} objects · ${demo ? "Sample scene" : "Recorded scene"}`;
  status.textContent = "Pause to move an object and make a new take.";
  loading.hidden = true; element<HTMLFieldSetElement>("timeline-controls").disabled = false;
  const debugLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }));
  debugLines.frustumCulled = false; debugLines.renderOrder = 100; scene.add(debugLines);
  // Ghosts have no pick proxy and no collider, so no outline either.
  const debugBoxes = memory.objects.flatMap(object => {
    const proxy = currentViewer.pickables.find(p => p.userData.objectId === object.definition.id);
    if (!proxy) return [];
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(proxy.geometry), new THREE.LineBasicMaterial({ color: 0xa3f3ce, depthTest: false }));
    object.root.add(lines); lines.visible = false; return [lines];
  });
  // The clip's audio follows the timeline (play, pause, seek, takes, the room's clock); the first tap or key starts it.
  const audioUrl = memory.manifest.source?.audioUrl;
  const audio = audioUrl ? mountAudio(new URL(audioUrl, new URL(manifestUrl, location.href)).href, document.querySelector("#timeline-controls .tools"), showWarning) : undefined;
  const xr = new XRInput(renderer, rig, camera, currentViewer, {
    preview: xrPreview,
    notice: () => warning.hidden ? status.textContent ?? "" : warning.textContent ?? "",
    unlockAudio: () => audio?.sync.unlock(),
    openLibrary: () => {
      const library = element<HTMLDialogElement>("room-panel");
      if (!library.open) element("room-toggle").click();
    },
  });
  desktopInput(renderer.domElement, camera, controls, viewer);
  navigator.xr?.isSessionSupported("immersive-vr").then(supported => {
    if (!supported || xrPreview) return;
    element("vr-button").appendChild(VRButton.createButton(renderer, { optionalFeatures: ["hand-tracking"] }));
    vrEntry.hidden = false;
  }).catch(() => { vrEntry.hidden = true; });
  let branchCount = 0;
  play.onclick = () => currentViewer.togglePlay();
  scrub.oninput = () => currentViewer.seek(Number(scrub.value) / 1000 * currentViewer.timeline.duration);
  branches.onchange = () => currentViewer.selectBranch(branches.value);
  element("original").onclick = () => currentViewer.selectBranch("original");
  element("restart").onclick = () => currentViewer.seek(0);
  element("export").onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentViewer.timeline.export(memory.manifest.id), null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `${memory.manifest.id}-takes.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const preEyesPosition = new THREE.Vector3(), preEyesTarget = new THREE.Vector3();
  eyes.onchange = () => {
    if (eyes.checked) { preEyesPosition.copy(camera.position); preEyesTarget.copy(controls.target); }
    else { camera.position.copy(preEyesPosition); controls.target.copy(preEyesTarget); camera.fov = 65; camera.updateProjectionMatrix(); }
    controls.enabled = !eyes.checked;
  };
  let previous = 0, frames = 0, elapsed = 0, lastUI = 0;
  renderer.setAnimationLoop(timestamp => {
    const dt = previous ? Math.min((timestamp - previous) / 1000, 0.1) : 0; previous = timestamp;
    xr.update(dt); currentViewer.update(dt);
    audio?.update(currentViewer.timeline.time, currentViewer.timeline.playing, currentViewer.timeline.speed);
    if (eyes.checked && !renderer.xr.isPresenting) {
      sampleTrack(memory.cameraTrack, currentViewer.timeline.time, camera);
      camera.fov = memory.manifest.camera.fovYDeg; camera.updateProjectionMatrix();
    } else if (!renderer.xr.isPresenting) { joystick.update(dt); if (controls.enabled && !xrPreview) controls.update(); }
    const tl = currentViewer.timeline;
    if (timestamp - lastUI > 100) {
      lastUI = timestamp; play.textContent = tl.playing ? "Pause" : "Play";
      scrub.value = String(tl.time / tl.duration * 1000);
      scrub.setAttribute("aria-valuetext", `${tl.time.toFixed(1)} of ${tl.duration.toFixed(1)} seconds`);
      element("time").textContent = `${tl.time.toFixed(1)} / ${tl.duration.toFixed(1)}s`;
      element("state").textContent = currentViewer.held ? "HOLDING" : currentViewer.recording ? "RECORDING THROW" : tl.playing ? "PLAYING" : "PAUSED";
      if (branchCount !== tl.branches.length) {
        branchCount = tl.branches.length; branches.replaceChildren();
        for (const branch of tl.branches) {
          const option = document.createElement("option"); option.value = branch.id;
          const parent = tl.branches.find(b => b.id === branch.parentId);
          option.textContent = branch.parentId ? `${branch.name} · ${parent?.name ?? "Original"} at ${branch.forkTime.toFixed(1)}s` : "Original recording";
          branches.add(option);
        }
        const markers = element("markers"); markers.replaceChildren();
        for (const branch of tl.branches.slice(1)) {
          const button = document.createElement("button"); button.className = "fork-marker";
          button.style.left = `${branch.forkTime / tl.duration * 100}%`; button.title = `${branch.name}: fork at ${branch.forkTime.toFixed(1)}s`;
          button.setAttribute("aria-label", button.title); button.textContent = "◆"; button.onclick = () => currentViewer.selectBranch(branch.id); markers.append(button);
        }
      }
      branches.value = tl.activeId;
      document.body.classList.toggle("wearer-view", eyes.checked);
    }
    debugLines.visible = debug.checked && currentViewer.physics.bodies.size > 0;
    debugBoxes.forEach(box => { box.visible = debug.checked && !debugLines.visible; });
    if (debugLines.visible) {
      const { vertices, colors } = currentViewer.physics.world.debugRender();
      debugLines.geometry.dispose(); debugLines.geometry = new THREE.BufferGeometry();
      debugLines.geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
      debugLines.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    }
    frames++; elapsed += dt;
    if (elapsed >= 1) { element("fps").textContent = `${Math.round(frames / elapsed)} fps`; frames = 0; elapsed = 0; }
    session.update(dt);
    renderer.render(scene, camera);
  });
  document.addEventListener("visibilitychange", () => { previous = 0; if (document.hidden) currentViewer.release(); });
  addEventListener("pagehide", () => { stageObserver.disconnect(); renderer.setAnimationLoop(null); xr.dispose(); audio?.dispose(); currentViewer.dispose(); spark.dispose(); renderer.dispose(); }, { once: true });
  session.attach(currentViewer);
  if (import.meta.env.DEV) {
    // Dev-only probe for multi-tab checks: compare positionsAt(t) across tabs of one room.
    const probe = new THREE.Object3D();
    window.__memreplay = {
      viewer: currentViewer, session, memory, audio,
      get adapter() { return session.adapter; },
      positionsAt: (t: number) => Object.fromEntries(memory.objects.map(o => {
        sampleTrack(currentViewer.timeline.track(o.definition.id, o.track, t), t, probe);
        return [o.definition.id, probe.position.toArray().map(v => Math.round(v * 1e4) / 1e4)];
      })),
      takes: () => currentViewer.timeline.branches.map(b => ({ id: b.id, parentId: b.parentId, name: b.name, forkTime: b.forkTime,
        frames: Object.fromEntries([...b.tracks].map(([id, frames]) => [id, frames.length])) })),
    };
  }
  window.dispatchEvent(new CustomEvent("memoryreplay:ready", { detail: currentViewer }));
}
element("reload").onclick = () => location.reload();
main().catch(error => {
  console.error(error); loading.hidden = true; element("reload").hidden = false;
  status.textContent = `Could not load this memory: ${error instanceof Error ? error.message : String(error)}`;
  warning.hidden = false; warning.textContent = "Check the manifest URL, asset URLs, and CORS access. The local demo works without pipeline assets.";
});
