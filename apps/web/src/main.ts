import * as THREE from "three";
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
import { PathGuide } from "./guided.js";
import { AutoHide, formatTime, mountVRButton, percentAt, popover, Toast } from "./ui.js";
import "./style.css";

declare global { interface Window { memoryReplay?: Viewer; __memreplay?: unknown; __memreplayScene?: unknown } }
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status"), loading = element("loading"), warning = element("warning");
const play = element<HTMLButtonElement>("play"), scrub = element<HTMLInputElement>("scrub");
const branches = element<HTMLSelectElement>("branches"), debug = element<HTMLInputElement>("debug");
const eyes = element<HTMLInputElement>("eyes"), guided = element<HTMLInputElement>("guided");
let viewer: Viewer | undefined;
const showWarning = (message: string) => { warning.hidden = false; warning.textContent = message; };
const toast = new Toast(element("toast"), status);

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const manifestUrl = params.get("memory") ?? "/mock/memory.json";
  const demo = !params.has("memory");
  // Dev only: ?xrPreview shows the headset panel on the desktop, worked with the mouse.
  const xrPreview = import.meta.env.DEV && params.has("xrPreview");
  document.body.classList.toggle("stats", params.has("stats"));
  document.body.classList.toggle("xr-preview", xrPreview);
  element("xr-preview-note").hidden = !xrPreview;
  const stage = element("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  // Sharper on phones and laptops, but at most 1.5× (splats are fill-rate bound); drops to 1× if frames suffer.
  let pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio); renderer.setSize(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight);
  renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType("local-floor"); renderer.xr.setFoveation(1);
  renderer.domElement.setAttribute("aria-label", "Interactive 3D memory. Pause, then drag an object to throw it.");
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b1118);
  scene.add(new THREE.HemisphereLight(0xbfeaf4, 0x374454, 2.5));
  const light = new THREE.DirectionalLight(0xffd7b5, 3); light.position.set(3, 5, 2); scene.add(light);
  const camera = new THREE.PerspectiveCamera(65, (stage.clientWidth || innerWidth) / (stage.clientHeight || innerHeight), 0.05, 200);
  if (innerWidth < 650) camera.position.set(1.3, 1.7, 1.2); else camera.position.set(2.5, 2.1, 3.5);
  const rig = new THREE.Group(); scene.add(rig); rig.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, -1); controls.enableDamping = true; controls.maxDistance = 20; controls.minDistance = 0.4;
  controls.maxPolarAngle = Math.PI * 0.49;
  // ?lod=0 draws every splat (the pipeline's render-vs-video captures use it).
  const spark = new SparkRenderer({ renderer, preUpdate: false, maxStdDev: Math.sqrt(5), lodSplatCount: 500_000,
    enableLod: params.get("lod") !== "0" });
  scene.add(spark);
  // Shared rooms (session.ts) connect while the memory loads. Without a room the viewer stays local.
  const session = new Session({ renderer, scene, camera, manifestUrl, showStatus: message => { status.textContent = message; } });
  addEventListener("pagehide", () => session.dispose(), { once: true });
  const joystick = new PhoneJoystick(element("joystick"), camera, controls);
  const touch = isTouchDevice();
  document.body.classList.toggle("touch", touch);
  // Keep the joystick, toast and sheets clear of the dock, whatever its height.
  const hud = element("hud");
  const hudSpace = () => document.documentElement.style.setProperty("--hud-space", `${Math.max(0, Math.round(innerHeight - hud.getBoundingClientRect().top))}px`);
  new ResizeObserver(hudSpace).observe(hud); addEventListener("resize", hudSpace); hudSpace();
  // The canvas fills the stage; follow it as phone browser bars come and go.
  const resizeScene = () => {
    if (renderer.xr.isPresenting) return;
    const { width, height } = stage.getBoundingClientRect();
    camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); renderer.setSize(width, Math.max(1, height));
  };
  const stageObserver = new ResizeObserver(resizeScene); stageObserver.observe(stage);
  const savedCamera = new THREE.Vector3(), savedTarget = new THREE.Vector3();
  // Enter VR where the wearer started, standing on the scene floor, facing their first heading.
  let vrSpawn = { x: 0, y: 0, z: 2, yaw: 0 };
  renderer.xr.addEventListener("sessionstart", () => {
    // Solo, VR starts from the beginning, paused, so there is time to look around and grab. In a room the clock is
    // shared, so only a memory that already played to its end (nothing left to grab) rewinds.
    if (viewer && (!session.adapter || viewer.timeline.time >= viewer.timeline.duration)) viewer.seek(0);
    savedCamera.copy(camera.position); savedTarget.copy(controls.target); controls.enabled = false;
    rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z); rig.rotation.set(0, vrSpawn.yaw, 0);
    eyes.checked = false; eyes.disabled = true; document.body.classList.add("in-xr");
  });
  renderer.xr.addEventListener("sessionend", () => {
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); camera.position.copy(savedCamera);
    controls.target.copy(savedTarget); controls.enabled = !xrPreview; eyes.disabled = false; document.body.classList.remove("in-xr");
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
  // The recorded path on the floor; guided mode keeps you near it and fogs what the camera never saw (guided.ts).
  const guide = new PathGuide(memory.cameraTrack, memory.manifest.world.floorY, memory.manifest.camera.fovYDeg,
    memory.manifest.source.width / memory.manifest.source.height, camera);
  scene.add(guide.root);
  // Stand where the wearer stood, at their eye height, looking the way they looked.
  const standOnPath = () => {
    if (renderer.xr.isPresenting || eyes.checked) return;
    const q = new THREE.Quaternion(...firstPose.q).normalize();
    camera.position.set(firstPose.p[0], firstPose.p[1], firstPose.p[2]);
    controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize().multiplyScalar(1.5));
    controls.update();
  };
  // A recorded memory opens from the wearer's first spot, inside the room, instead of outside it.
  if (!demo) standOnPath();
  guided.checked = params.get("mode") === "guided";
  guide.setGuided(guided.checked);
  if (guided.checked) standOnPath();
  guided.onchange = () => { guide.setGuided(guided.checked); if (guided.checked) standOnPath(); };
  const headPos = new THREE.Vector3(), headQuat = new THREE.Quaternion(), correction = new THREE.Vector3();
  // Lost-tracking stretches (the pipeline writes timeline.gaps; older memories have none).
  const gaps = (memory.manifest.timeline as { gaps?: [number, number][] }).gaps ?? [];
  const inGap = (t: number) => gaps.some(([a, b]) => t >= a && t <= b);
  const grid = new THREE.GridHelper(10, 40, 0x3c6f70, 0x1f3039); grid.position.y = memory.manifest.world.floorY; scene.add(grid);
  // A reconstructed room has its own floor, and splats write no depth, so the grid would draw over it.
  grid.visible = demo || !memory.manifest.background?.url;
  // For scripted screenshots (the pipeline's capture tool) and debugging, in every build.
  window.__memreplayScene = { scene, grid, guide, camera, renderer };
  viewer = new Viewer(memory, message => { status.textContent = message; }); window.memoryReplay = viewer;
  const currentViewer = viewer;
  desktopInput(renderer.domElement, camera, controls, viewer);
  const duration = memory.manifest.timeline.durationSec;
  const title = demo ? "Practice room" : memory.manifest.title;
  element("title").textContent = title;
  element("mode").textContent = demo ? "Sample scene" : "Recorded";
  const grabbable = memory.objects.filter(o => o.definition.grabbable).length;
  element("asset-info").textContent = `${formatTime(duration)} · ${grabbable} ${grabbable === 1 ? "object" : "objects"} to throw`;
  document.title = `${title} · Memory Replay`;
  status.textContent = touch ? "Pause, then drag an object where you want it. Play shows what happens."
    : "Pause (Space), then drag an object where you want it. Play shows what happens.";
  loading.hidden = true; element<HTMLFieldSetElement>("timeline-controls").disabled = false;
  element("time-total").textContent = formatTime(duration);
  // Lost-tracking stretches on the scrubber.
  element("gaps").replaceChildren(...gaps.map(([a, b]) => {
    const band = document.createElement("span");
    band.style.left = `${percentAt(a, duration)}%`; band.style.width = `${Math.max(0.6, percentAt(b, duration) - percentAt(a, duration))}%`;
    band.title = "Tracking was lost here";
    return band;
  }));
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
  const audio = audioUrl ? mountAudio(new URL(audioUrl, new URL(manifestUrl, location.href)).href, element("more-toggles"), showWarning) : undefined;
  // The VR panel shows the same status line as the 2D overlay, and the room summary from the room panel.
  const xr = new XRInput(renderer, rig, camera, currentViewer, {
    status: () => status.textContent ?? "",
    room: () => {
      const summary = element("room-summary").textContent ?? "";
      return summary === "" || summary === "Solo" ? "Solo" : summary.startsWith("Joining") ? summary : `Room ${summary}`;
    },
    title: () => title,
    gaps: () => gaps,
    unlockAudio: () => audio?.sync.unlock(),
  }, xrPreview ? renderer.domElement : undefined);
  if (xrPreview) { standOnPath(); controls.enabled = false; }
  mountVRButton(renderer, element<HTMLButtonElement>("vr-entry"));
  const more = popover(element<HTMLButtonElement>("more-toggle"), element("more-sheet"));
  const autoHide = new AutoHide(document.body);
  let branchCount = 0;
  play.onclick = () => currentViewer.togglePlay();
  scrub.oninput = () => currentViewer.seek(Number(scrub.value) / 1000 * currentViewer.timeline.duration);
  branches.onchange = () => currentViewer.selectBranch(branches.value);
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
    controls.enabled = !eyes.checked && !xrPreview;
  };
  const markers = element("markers"), roomPanel = element<HTMLDialogElement>("room-panel");
  let previous = 0, frames = 0, elapsed = 0, lastUI = 0, slowSeconds = 0, wasPlaying = false;
  renderer.setAnimationLoop(timestamp => {
    const dt = previous ? Math.min((timestamp - previous) / 1000, 0.1) : 0; previous = timestamp;
    xr.update(dt); currentViewer.update(dt);
    audio?.update(currentViewer.timeline.time, currentViewer.timeline.playing, currentViewer.timeline.speed);
    if (eyes.checked && !renderer.xr.isPresenting) {
      sampleTrack(memory.cameraTrack, currentViewer.timeline.time, camera);
      camera.fov = memory.manifest.camera.fovYDeg; camera.updateProjectionMatrix();
    } else if (!renderer.xr.isPresenting) { joystick.update(dt); if (controls.enabled) controls.update(); }
    // Lost-tracking stretches: the room there was never reconstructed, so guided mode and the wearer's view fade out.
    const lost = inGap(currentViewer.timeline.time) && (guide.guided || eyes.checked);
    if (guide.guided && !eyes.checked) {
      camera.getWorldPosition(headPos); camera.getWorldQuaternion(headQuat);
      const outside = guide.excess(headPos);
      guide.clamp(headPos, correction);
      if (renderer.xr.isPresenting) rig.position.add(correction);           // the world slides back under you
      else { camera.position.add(correction); controls.target.add(correction); }
      guide.update(headPos, headQuat, outside, dt);
    }
    guide.blackout(lost, dt);
    const tl = currentViewer.timeline;
    if (timestamp - lastUI > 100) {
      lastUI = timestamp;
      // Playback just reached the end: nothing can be grabbed there, so say what to do next.
      if (wasPlaying && !tl.playing && tl.time >= tl.duration) status.textContent = touch
        ? "That's the end. Press Play to watch again, or drag the timeline back to throw something."
        : "That's the end. Press Play (Space) to watch again, or scrub back to throw something.";
      wasPlaying = tl.playing;
      play.classList.toggle("playing", tl.playing); play.setAttribute("aria-label", tl.playing ? "Pause" : "Play");
      scrub.value = String(tl.time / tl.duration * 1000);
      scrub.style.setProperty("--progress", `${percentAt(tl.time, tl.duration)}%`);
      scrub.setAttribute("aria-valuetext", `${formatTime(tl.time)} of ${formatTime(tl.duration)}`);
      element("time-now").textContent = formatTime(tl.time);
      element("state").textContent = currentViewer.held ? (currentViewer.isPlaced ? "PLACED" : "HOLDING") : currentViewer.recording ? "RECORDING THROW" : tl.playing ? "PLAYING" : "PAUSED";
      if (branchCount !== tl.branches.length) {
        branchCount = tl.branches.length; branches.replaceChildren();
        for (const branch of tl.branches) {
          const parent = tl.branches.find(b => b.id === branch.parentId);
          // Short, because the pill shows it: "Take 2 · 0:12" (made at 0:12), or "· from Take 1" when it branched off a take.
          const from = parent?.parentId ? ` from ${parent.name}` : "";
          branches.add(new Option(branch.parentId ? `${branch.name} · ${formatTime(branch.forkTime)}${from}` : "Original", branch.id));
        }
        markers.replaceChildren(...tl.branches.slice(1).map(branch => {
          const button = document.createElement("button"); button.className = "fork-marker"; button.dataset.take = branch.id;
          button.style.left = `${percentAt(branch.forkTime, tl.duration)}%`; button.title = `${branch.name}: made at ${formatTime(branch.forkTime)}`;
          button.setAttribute("aria-label", button.title); button.onclick = () => currentViewer.selectBranch(branch.id);
          return button;
        }));
      }
      branches.value = tl.activeId;
      markers.querySelectorAll<HTMLElement>(".fork-marker").forEach(marker => marker.classList.toggle("active", marker.dataset.take === tl.activeId));
      document.body.classList.toggle("wearer-view", eyes.checked);
      // Keep the status up while it matters (a hold or a throw); fade the overlay while the memory just plays.
      toast.hold(!!currentViewer.held || currentViewer.recording);
      autoHide.update(tl.playing && !currentViewer.held && !more.open && !roomPanel.open && warning.hidden && !scrub.matches(":active"));
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
    if (elapsed >= 1) {
      const fps = frames / elapsed;
      element("fps").textContent = `${Math.round(fps)} fps`; frames = 0; elapsed = 0;
      // Two slow seconds in a row on the 2D view: render at 1× instead.
      slowSeconds = fps < 40 && !renderer.xr.isPresenting && !document.hidden ? slowSeconds + 1 : 0;
      if (slowSeconds >= 2 && pixelRatio > 1) { pixelRatio = 1; renderer.setPixelRatio(1); resizeScene(); }
    }
    session.update(dt);
    renderer.render(scene, camera);
    // In VR, Spark sorts splats on a timer between frames and then restores whatever render target was current. After a
    // VR frame that is the headset's frame surface, which expires with the frame, so the restore fails with a WebGL
    // INVALID_OPERATION about 120 times a second. Leave no target current; three sets the VR one again next frame.
    if (renderer.xr.isPresenting) renderer.setRenderTarget(null);
  });
  document.addEventListener("visibilitychange", () => { previous = 0; if (document.hidden) currentViewer.release(); });
  addEventListener("pagehide", () => {
    stageObserver.disconnect(); renderer.setAnimationLoop(null); xr.dispose(); audio?.dispose(); currentViewer.dispose(); spark.dispose(); renderer.dispose();
  }, { once: true });
  session.attach(currentViewer);
  if (import.meta.env.DEV) {
    // Dev-only handles: multi-tab checks compare positionsAt(t) across tabs of one room; scripted screenshots use the rest.
    const probe = new THREE.Object3D();
    window.__memreplay = {
      viewer: currentViewer, session, memory, audio, scene, grid, guide, camera, renderer, xr,
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
  warning.hidden = false; warning.textContent = "Check the manifest URL, asset URLs, and CORS access. The sample scene works without pipeline assets.";
});
