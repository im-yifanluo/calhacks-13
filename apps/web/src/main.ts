import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { loadMemory } from "./engine/loader";
import { initPhysics } from "./engine/physics";
import { Viewer } from "./engine/viewer";
import { XRInput } from "./xr/input";
import { desktopInput } from "./input/desktop";
import { wearerPose, releaseWearer } from "./camera/wearer";
import { sampleTrack } from "./engine/tracks";
import { mountAudio } from "./engine/audio";
import { mountAuth } from "./account/auth";
import { DEFAULT_MANIFEST, loadedManifest } from "./party/routes";
import { Session } from "./party/session";
import { PhoneJoystick, isTouchDevice } from "./input/joystick";
import { PathGuide } from "./camera/guided";
import { PathFollower, placeHead } from "./camera/follow";
import { applyExposure, clearExposure } from "./camera/exposure";
import { AutoHide, mountVRButton, percentAt, popover, Toast } from "./ui/overlay";
import { mountSceneOnly } from "./ui/scene-only";
import "./styles/viewer.css";
import { getImportedScene } from "./scenes/store";
import { byId as element } from "./lib/dom";
import { formatTime } from "./lib/format";

declare global {
  interface Window {
    memoryReplay?: Viewer;
    __memreplay?: unknown;
    __memreplayScene?: unknown;
  }
}
const status = element("status"),
  loading = element("loading"),
  warning = element("warning");
const play = element<HTMLButtonElement>("play"),
  scrub = element<HTMLInputElement>("scrub");
const branches = element<HTMLSelectElement>("branches"),
  debug = element<HTMLInputElement>("debug");
const eyes = element<HTMLInputElement>("eyes"),
  guided = element<HTMLInputElement>("guided");
const cameraMode = element<HTMLButtonElement>("camera-mode");
const follow = element<HTMLInputElement>("follow"),
  viewMode = element<HTMLButtonElement>("view-mode");
let viewer: Viewer | undefined;
let sceneOnly: ReturnType<typeof mountSceneOnly> | undefined;
const showWarning = (message: string) => {
  warning.hidden = false;
  warning.textContent = message;
};
const toast = new Toast(element("toast"), status);

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const importId = params.get("import");
  let importedSource: (import("./engine/loader").MemorySource & { dispose: () => void }) | undefined;
  if (importId) {
    const stored = await getImportedScene(importId);
    if (!stored)
      throw new Error(
        "This import is not saved for your signed-in account on this browser. Sign in with its password in the library, or import the .memos.zip again.",
      );
    const { localSceneSource } = await import("./scenes/bundle");
    importedSource = localSceneSource(stored);
    addEventListener("pagehide", () => importedSource?.dispose(), { once: true });
  }
  const manifestUrl = importedSource
    ? new URL(`/local-import/${encodeURIComponent(importId!)}/memory.json`, location.href).href
    : loadedManifest(location.href, sessionStorage);
  const sceneUrl = new URL(manifestUrl, location.href);
  const demo = !importedSource && sceneUrl.origin === location.origin && sceneUrl.pathname === DEFAULT_MANIFEST;
  // Dev only: ?xrPreview shows the headset panel on the desktop, worked with the mouse.
  const xrPreview = import.meta.env.DEV && params.has("xrPreview");
  document.body.classList.toggle("stats", params.has("stats"));
  document.body.classList.toggle("xr-preview", xrPreview);
  element("xr-preview-note").hidden = !xrPreview;
  const stage = element("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  // Sharper on phones and laptops, but at most 1.5× (splats are fill-rate bound); drops to 1× if frames suffer.
  let pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.xr.setFoveation(1);
  renderer.domElement.setAttribute("aria-label", "Interactive 3D memory. Pause, then drag an object to throw it.");
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f);
  scene.add(new THREE.HemisphereLight(0xbfeaf4, 0x374454, 2.5));
  const light = new THREE.DirectionalLight(0xffd7b5, 3);
  light.position.set(3, 5, 2);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(
    65,
    (stage.clientWidth || innerWidth) / (stage.clientHeight || innerHeight),
    0.05,
    200,
  );
  if (innerWidth < 650) camera.position.set(1.3, 1.7, 1.2);
  else camera.position.set(2.5, 2.1, 3.5);
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, -1);
  controls.enableDamping = true;
  controls.maxDistance = 20;
  controls.minDistance = 0.4;
  // Allow looking above and below the captured horizon while exploring a room.
  controls.maxPolarAngle = Math.PI;
  const updateCameraModeButton = () => {
    cameraMode.textContent = eyes.checked
      ? "Camera: Wearer's view"
      : follow.checked
        ? "Camera: Follow walk"
        : "Camera: Free look";
    cameraMode.setAttribute("aria-pressed", String(eyes.checked));
    cameraMode.title = eyes.checked
      ? "Switch to free look: drag to explore and scroll or pinch to zoom"
      : "Follow the recorded camera path";
    cameraMode.disabled = eyes.disabled || xrPreview;
  };
  // ?lod=0 draws every splat (the pipeline's render-vs-video captures use it).
  const spark = new SparkRenderer({
    renderer,
    preUpdate: false,
    maxStdDev: Math.sqrt(5),
    lodSplatCount: 500_000,
    enableLod: params.get("lod") !== "0",
  });
  scene.add(spark);
  // Shared rooms (party/session.ts) connect while the memory loads. Without a room the viewer stays local.
  const session = new Session({
    renderer,
    scene,
    camera,
    manifestUrl,
    localImport: !!importedSource,
    showStatus: (message) => {
      status.textContent = message;
    },
  });
  mountAuth(session.net);
  addEventListener("pagehide", () => session.dispose(), { once: true });
  const joystick = new PhoneJoystick(element("joystick"), camera, controls);
  const touch = isTouchDevice();
  document.body.classList.toggle("touch", touch);
  // Keep the joystick, toast and sheets clear of the dock, whatever its height.
  const hud = element("hud");
  const hudSpace = () =>
    document.documentElement.style.setProperty(
      "--hud-space",
      `${Math.max(0, Math.round(innerHeight - hud.getBoundingClientRect().top))}px`,
    );
  new ResizeObserver(hudSpace).observe(hud);
  addEventListener("resize", hudSpace);
  hudSpace();
  // The top actions wrap on phones; status messages must stay below every row of buttons.
  const topbar = element("topbar");
  const topbarSpace = () =>
    document.documentElement.style.setProperty(
      "--topbar-height",
      `${Math.ceil(topbar.getBoundingClientRect().height)}px`,
    );
  new ResizeObserver(topbarSpace).observe(topbar);
  topbarSpace();
  // The canvas fills the stage; follow it as phone browser bars come and go.
  const resizeScene = () => {
    if (renderer.xr.isPresenting) return;
    const { width, height } = stage.getBoundingClientRect();
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, Math.max(1, height));
  };
  const stageObserver = new ResizeObserver(resizeScene);
  stageObserver.observe(stage);
  const savedCamera = new THREE.Vector3(),
    savedTarget = new THREE.Vector3();
  // Enter VR where the wearer started, standing on the scene floor, facing their first heading.
  let vrSpawn = { x: 0, y: 0, z: 2, yaw: 0 };
  renderer.xr.addEventListener("sessionstart", () => {
    // Solo, VR starts from the beginning, paused, so there is time to look around and grab. In a room the clock is
    // shared, so only a memory that already played to its end (nothing left to grab) rewinds.
    if (viewer && (!session.adapter || viewer.timeline.time >= viewer.timeline.duration)) viewer.seek(0);
    if (eyes.checked) {
      eyes.checked = false;
      eyes.dispatchEvent(new Event("change"));
    }
    savedCamera.copy(camera.position);
    savedTarget.copy(controls.target);
    controls.enabled = false;
    rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z);
    rig.rotation.set(0, vrSpawn.yaw, 0);
    eyes.disabled = true;
    updateCameraModeButton();
    document.body.classList.add("in-xr");
  });
  renderer.xr.addEventListener("sessionend", () => {
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    camera.position.copy(savedCamera);
    controls.target.copy(savedTarget);
    controls.enabled = !xrPreview;
    eyes.disabled = false;
    document.body.classList.remove("in-xr");
    updateCameraModeButton();
    resizeScene();
  });
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    sceneOnly?.show();
    event.preventDefault();
    renderer.setAnimationLoop(null);
    status.textContent = "Graphics context lost. Reload to recover.";
    element("reload").hidden = false;
  });
  await initPhysics();
  const memory = await loadMemory(manifestUrl, demo, showWarning, importedSource);
  const firstPose = memory.cameraTrack[0];
  vrSpawn = {
    x: firstPose.p[0],
    y: memory.manifest.world.floorY,
    z: firstPose.p[2],
    yaw: new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...firstPose.q).normalize(), "YXZ").y,
  };
  if (renderer.xr.isPresenting) {
    rig.position.set(vrSpawn.x, vrSpawn.y, vrSpawn.z);
    rig.rotation.set(0, vrSpawn.yaw, 0);
  }
  scene.add(memory.root);
  // The recorded path on the floor; guided mode keeps you near it and fogs what the camera never saw (camera/guided.ts).
  const guide = new PathGuide(
    memory.cameraTrack,
    memory.manifest.world.floorY,
    memory.manifest.camera.fovYDeg,
    memory.manifest.source.width / memory.manifest.source.height,
    camera,
  );
  scene.add(guide.root);
  // Stand where the wearer stood, at their eye height, looking the way they looked.
  const standOnPath = () => {
    if (renderer.xr.isPresenting || eyes.checked) return;
    const q = new THREE.Quaternion(...firstPose.q).normalize();
    camera.position.set(firstPose.p[0], firstPose.p[1], firstPose.p[2]);
    controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(1.5));
    controls.update();
  };
  // A recorded memory opens from the wearer's first spot, inside the room, instead of outside it.
  if (!demo) standOnPath();
  const mode = params.get("mode");
  guided.checked = mode === "guided";
  guide.setGuided(guided.checked);
  if (guided.checked) standOnPath();
  // Hosted recordings default to follow mode; local imports open free so scrolling works. While following you walk
  // the recorded path and look where you like; paused, you roam anywhere. ?mode=free and ?mode=guided leave it off.
  const follower = new PathFollower(memory.cameraTrack);
  const followPos = new THREE.Vector3(),
    eyePos = new THREE.Vector3(),
    shift = new THREE.Vector3();
  // A drag turns the view where you stand (it moves the scene with the pointer, as in a photo sphere) instead of
  // orbiting a point ahead, and you can look up as well as down. Off again, the orbit's limits come back.
  const followLook = (on: boolean) => {
    controls.rotateSpeed = on ? -0.35 : 1;
    controls.enableZoom = !on;
    controls.minPolarAngle = on ? Math.PI * 0.05 : 0;
    controls.maxPolarAngle = on ? Math.PI * 0.95 : Math.PI;
  };
  let lookInPlace = false;
  const setFollow = (on: boolean) => {
    if (on !== lookInPlace) {
      lookInPlace = on;
      followLook(on);
    }
    follow.checked = on;
    updateCameraModeButton();
    if (on && guided.checked) {
      guided.checked = false;
      guide.setGuided(false);
    } // three modes: follow, free (guided), eyes
  };
  setFollow(!demo && !xrPreview && (mode === "follow" || (mode === null && !importedSource)));
  follow.onchange = () => {
    const on = follow.checked;
    if (on && eyes.checked) {
      eyes.checked = false;
      applyEyes();
    }
    setFollow(on);
  };
  guided.onchange = () => {
    if (guided.checked && follow.checked) setFollow(false);
    guide.setGuided(guided.checked);
    if (guided.checked) standOnPath();
  };
  const headPos = new THREE.Vector3(),
    headQuat = new THREE.Quaternion(),
    correction = new THREE.Vector3();
  // Lost-tracking stretches (the pipeline writes timeline.gaps; older memories have none).
  const gaps = (memory.manifest.timeline as { gaps?: [number, number][] }).gaps ?? [];
  const inGap = (t: number) => gaps.some(([a, b]) => t >= a && t <= b);
  const grid = new THREE.GridHelper(10, 40, 0x3c6f70, 0x1f3039);
  grid.position.y = memory.manifest.world.floorY;
  scene.add(grid);
  // A reconstructed room has its own floor, and splats write no depth, so the grid would draw over it.
  grid.visible = demo || !memory.manifest.background?.url;
  // For scripted screenshots (the pipeline's capture tool) and debugging, in every build.
  window.__memreplayScene = { scene, grid, guide, camera, renderer };
  viewer = new Viewer(memory, (message) => {
    status.textContent = message;
  });
  window.memoryReplay = viewer;
  const currentViewer = viewer;
  desktopInput(
    renderer.domElement,
    camera,
    controls,
    viewer,
    () => !document.body.classList.contains("scene-only"),
    () =>
      !eyes.checked && !xrPreview && !renderer.xr.isPresenting && !(follow.checked && currentViewer.timeline.playing),
  );
  const duration = memory.manifest.timeline.durationSec;
  const title = demo ? "Practice room" : memory.manifest.title;
  element("title").textContent = title;
  element("mode").textContent = importedSource ? "Local import" : demo ? "Sample scene" : "Recorded";
  const grabbable = memory.objects.filter((o) => o.definition.grabbable).length;
  element("asset-info").textContent =
    `${formatTime(duration)} · ${grabbable} ${grabbable === 1 ? "object" : "objects"} to throw`;
  document.title = `${title} · memos`;
  status.textContent = follow.checked
    ? touch
      ? "Following the recorded walk. Pause to roam. Drag to look."
      : "Following the recorded walk. Space: pause to roam. Drag to look."
    : touch
      ? "Free look: drag to explore, pinch to zoom, use WALK to move."
      : "Free look: drag to explore, scroll to zoom, use WASD to move.";
  loading.hidden = true;
  element<HTMLFieldSetElement>("timeline-controls").disabled = false;
  element("time-total").textContent = formatTime(duration);
  // Lost-tracking stretches on the scrubber.
  element("gaps").replaceChildren(
    ...gaps.map(([a, b]) => {
      const band = document.createElement("span");
      band.style.left = `${percentAt(a, duration)}%`;
      band.style.width = `${Math.max(0.6, percentAt(b, duration) - percentAt(a, duration))}%`;
      band.title = "Tracking was lost here";
      return band;
    }),
  );
  const debugLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }),
  );
  debugLines.frustumCulled = false;
  debugLines.renderOrder = 100;
  scene.add(debugLines);
  // Ghosts have no pick proxy and no collider, so no outline either.
  const debugBoxes = memory.objects.flatMap((object) => {
    const proxy = currentViewer.pickables.find((p) => p.userData.objectId === object.definition.id);
    if (!proxy) return [];
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(proxy.geometry),
      new THREE.LineBasicMaterial({ color: 0xa3f3ce, depthTest: false }),
    );
    object.root.add(lines);
    lines.visible = false;
    return [lines];
  });
  // The clip's audio follows the timeline (play, pause, seek, takes, the room's clock); the first tap or key starts it.
  const audioUrl = memory.manifest.source?.audioUrl;
  const audio = audioUrl
    ? mountAudio(
        importedSource
          ? importedSource.resolveAsset(audioUrl)
          : new URL(audioUrl, new URL(manifestUrl, location.href)).href,
        element("more-toggles"),
        showWarning,
      )
    : undefined;
  // The VR panel shows the same status line as the 2D overlay, and the room summary from the room panel.
  const xr = new XRInput(
    renderer,
    rig,
    camera,
    currentViewer,
    {
      status: () => status.textContent ?? "",
      room: () => {
        const summary = element("room-summary").textContent ?? "";
        return summary === "" || summary === "Solo"
          ? "Solo"
          : summary.startsWith("Joining")
            ? summary
            : `Party ${summary}`;
      },
      title: () => title,
      gaps: () => gaps,
      unlockAudio: () => audio?.sync.unlock(),
    },
    xrPreview ? renderer.domElement : undefined,
  );
  if (xrPreview) {
    standOnPath();
    controls.enabled = false;
  }
  mountVRButton(renderer, element<HTMLButtonElement>("vr-entry"));
  const more = popover(element<HTMLButtonElement>("more-toggle"), element("more-sheet"));
  const autoHide = new AutoHide(document.body);
  sceneOnly = mountSceneOnly(stage, element<HTMLButtonElement>("hide-ui"), () => autoHide.wake());
  element<HTMLButtonElement>("hide-ui").disabled = false;
  let branchCount = 0;
  play.onclick = () => currentViewer.togglePlay();
  scrub.oninput = () => currentViewer.seek((Number(scrub.value) / 1000) * currentViewer.timeline.duration);
  branches.onchange = () => currentViewer.selectBranch(branches.value);
  element("restart").onclick = () => currentViewer.seek(0);
  element("export").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(currentViewer.timeline.export(memory.manifest.id), null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${memory.manifest.id}-takes.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function applyEyes() {
    // Both toggles start at the current recorded time; leaving never restores an old free camera.
    setFollow(false);
    wearerPose(camera, memory.cameraTrack, currentViewer.timeline.time, memory.manifest.camera.fovYDeg);
    if (eyes.checked) applyExposure(renderer.domElement, memory.cameraTrack, currentViewer.timeline.time);
    else {
      releaseWearer(camera, controls);
      clearExposure(renderer.domElement);
    }
    controls.enabled = !eyes.checked && !xrPreview && !renderer.xr.isPresenting;
    updateCameraModeButton();
    status.textContent = eyes.checked
      ? "Following the recorded camera. Tap the view chip above the controls to switch."
      : touch
        ? "Free look: drag to explore, pinch to zoom, use WALK to move."
        : "Free look: drag to explore, scroll to zoom, use WASD to move.";
  }
  eyes.onchange = applyEyes;
  cameraMode.onclick = () => {
    eyes.checked = !eyes.checked;
    applyEyes();
  };
  updateCameraModeButton();
  viewMode.hidden = false;
  viewMode.onclick = () => {
    if (eyes.checked) {
      eyes.checked = false;
      applyEyes();
      setFollow(true);
    } else if (follow.checked) setFollow(false);
    else if (!eyes.disabled) {
      eyes.checked = true;
      applyEyes();
    } else setFollow(true);
  };
  // Pausing while following frees you to roam: say how, once, as the clock stops (an XR grab's "Holding…" follows it).
  let framePlaying = currentViewer.timeline.playing;
  currentViewer.subscribe((event) => {
    if (event.type !== "clock" || event.playing || !framePlaying || !follow.checked || eyes.checked) return;
    if (currentViewer.timeline.time >= currentViewer.timeline.duration) return;
    status.textContent = renderer.xr.isPresenting
      ? "Paused: roam with the left stick, or grab something. Play takes you back to the walk."
      : touch
        ? "Paused: roam with the WALK pad, or drag an object. Play glides you back to the walk."
        : "Paused: roam with W/A/S/D, or drag an object. Play glides you back to the walk.";
  });
  const markers = element("markers"),
    roomPanel = element<HTMLDialogElement>("room-panel");
  let previous = 0,
    frames = 0,
    elapsed = 0,
    lastUI = 0,
    slowSeconds = 0,
    wasPlaying = false;
  renderer.setAnimationLoop((timestamp) => {
    const dt = previous ? Math.min((timestamp - previous) / 1000, 0.1) : 0;
    previous = timestamp;
    xr.update(dt);
    currentViewer.update(dt);
    audio?.update(currentViewer.timeline.time, currentViewer.timeline.playing, currentViewer.timeline.speed);
    // Follow mode: while the memory plays, the eyes are locked to the recorded path (wearer's view overrides it).
    const following = follow.checked && !eyes.checked,
      locked = following && currentViewer.timeline.playing;
    if (eyes.checked && !renderer.xr.isPresenting) {
      wearerPose(camera, memory.cameraTrack, currentViewer.timeline.time, memory.manifest.camera.fovYDeg);
      applyExposure(renderer.domElement, memory.cameraTrack, currentViewer.timeline.time); // the recording's auto-exposure
      follower.step(false, 0, camera.position, dt, followPos);
    } else if (!renderer.xr.isPresenting) {
      clearExposure(renderer.domElement);
      if (!locked) joystick.update(dt);
      if (controls.enabled) {
        eyePos.copy(camera.position);
        controls.update();
        // Following, a drag only turns the view: put the eyes back where they were, the target with them.
        if (following) {
          shift.subVectors(eyePos, camera.position);
          camera.position.add(shift);
          controls.target.add(shift);
        }
      }
      // Camera and target move together, so the look direction stays yours (also while gliding back on Play).
      if (
        follower.step(locked, currentViewer.timeline.time, camera.position, dt, followPos, currentViewer.timeline.speed)
      ) {
        shift.subVectors(followPos, camera.position);
        camera.position.add(shift);
        controls.target.add(shift);
      }
    } else {
      // VR: the rig moves so the headset lands on the path; the head turns freely.
      camera.getWorldPosition(headPos);
      if (follower.step(locked, currentViewer.timeline.time, headPos, dt, followPos, currentViewer.timeline.speed))
        placeHead(rig, camera, followPos);
    }
    // Lost-tracking stretches: the room there was never reconstructed, so guided mode, the wearer's view and the
    // followed walk fade out.
    const lost = inGap(currentViewer.timeline.time) && (guide.guided || eyes.checked || locked);
    if (guide.guided && !eyes.checked) {
      camera.getWorldPosition(headPos);
      camera.getWorldQuaternion(headQuat);
      const outside = guide.excess(headPos);
      guide.clamp(headPos, correction);
      if (renderer.xr.isPresenting)
        rig.position.add(correction); // the world slides back under you
      else {
        camera.position.add(correction);
        controls.target.add(correction);
      }
      guide.update(headPos, headQuat, outside, dt);
    }
    guide.blackout(lost, dt);
    const tl = currentViewer.timeline;
    if (timestamp - lastUI > 100) {
      lastUI = timestamp;
      // Playback just reached the end: nothing can be grabbed there, so say what to do next.
      if (wasPlaying && !tl.playing && tl.time >= tl.duration)
        status.textContent = touch
          ? "That's the end. Press Play to watch again, or drag the timeline back to throw something."
          : "That's the end. Press Play (Space) to watch again, or scrub back to throw something.";
      wasPlaying = tl.playing;
      play.classList.toggle("playing", tl.playing);
      play.setAttribute("aria-label", tl.playing ? "Pause" : "Play");
      scrub.value = String((tl.time / tl.duration) * 1000);
      scrub.style.setProperty("--progress", `${percentAt(tl.time, tl.duration)}%`);
      scrub.setAttribute("aria-valuetext", `${formatTime(tl.time)} of ${formatTime(tl.duration)}`);
      element("time-now").textContent = formatTime(tl.time);
      element("state").textContent = currentViewer.held
        ? currentViewer.isPlaced
          ? "PLACED"
          : "HOLDING"
        : currentViewer.recording
          ? "RECORDING THROW"
          : tl.playing
            ? "PLAYING"
            : "PAUSED";
      if (branchCount !== tl.branches.length) {
        branchCount = tl.branches.length;
        branches.replaceChildren();
        for (const branch of tl.branches) {
          const parent = tl.branches.find((b) => b.id === branch.parentId);
          // Short, because the pill shows it: "Take 2 · 0:12" (made at 0:12), or "· from Take 1" when it branched off a take.
          const from = parent?.parentId ? ` from ${parent.name}` : "";
          branches.add(
            new Option(
              branch.parentId ? `${branch.name} · ${formatTime(branch.forkTime)}${from}` : "Original",
              branch.id,
            ),
          );
        }
        markers.replaceChildren(
          ...tl.branches.slice(1).map((branch) => {
            const button = document.createElement("button");
            button.className = "fork-marker";
            button.dataset.take = branch.id;
            button.style.left = `${percentAt(branch.forkTime, tl.duration)}%`;
            button.title = `${branch.name}: made at ${formatTime(branch.forkTime)}`;
            button.setAttribute("aria-label", button.title);
            button.onclick = () => currentViewer.selectBranch(branch.id);
            return button;
          }),
        );
      }
      branches.value = tl.activeId;
      const canControl = session.canControlTime;
      for (const id of ["play", "restart", "scrub", "branches", "original"]) {
        const control = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
        if (control) control.disabled = !canControl;
      }
      document.querySelectorAll<HTMLButtonElement>(".fork-marker").forEach((marker) => {
        marker.disabled = !canControl;
      });
      markers
        .querySelectorAll<HTMLElement>(".fork-marker")
        .forEach((marker) => marker.classList.toggle("active", marker.dataset.take === tl.activeId));
      document.body.classList.toggle("wearer-view", eyes.checked);
      document.body.classList.toggle("follow-locked", locked);
      const view = eyes.checked
        ? "eyes"
        : follow.checked
          ? tl.playing
            ? "follow"
            : "roam"
          : guide.guided
            ? "guided"
            : "free";
      if (viewMode.dataset.mode !== view) {
        viewMode.dataset.mode = view;
        element("view-mode-label").textContent = {
          eyes: "Wearer's view",
          follow: "Following the walk",
          roam: "Paused · roam freely",
          guided: "Guided path",
          free: "Free camera",
        }[view];
        // Say where a click goes (the same order as viewMode.onclick).
        const next =
          view === "eyes"
            ? "follow the walk"
            : view === "follow" || view === "roam"
              ? "free camera"
              : eyes.disabled
                ? "follow the walk"
                : "wearer's view";
        viewMode.title = `Switch to ${next}`;
        viewMode.setAttribute("aria-description", `Click to switch to ${next}`);
      }
      // Keep the status up while it matters (a hold or a throw); fade the overlay while the memory just plays.
      toast.hold(!!currentViewer.held || currentViewer.recording);
      autoHide.update(
        tl.playing &&
          !currentViewer.held &&
          !more.open &&
          !roomPanel.open &&
          warning.hidden &&
          !scrub.matches(":active"),
      );
    }
    debugLines.visible = debug.checked && currentViewer.physics.bodies.size > 0;
    debugBoxes.forEach((box) => {
      box.visible = debug.checked && !debugLines.visible;
    });
    if (debugLines.visible) {
      const { vertices, colors } = currentViewer.physics.world.debugRender();
      debugLines.geometry.dispose();
      debugLines.geometry = new THREE.BufferGeometry();
      debugLines.geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
      debugLines.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    }
    frames++;
    elapsed += dt;
    if (elapsed >= 1) {
      const fps = frames / elapsed;
      element("fps").textContent = `${Math.round(fps)} fps`;
      frames = 0;
      elapsed = 0;
      // Two slow seconds in a row on the 2D view: render at 1× instead.
      slowSeconds = fps < 40 && !renderer.xr.isPresenting && !document.hidden ? slowSeconds + 1 : 0;
      if (slowSeconds >= 2 && pixelRatio > 1) {
        pixelRatio = 1;
        renderer.setPixelRatio(1);
        resizeScene();
      }
    }
    session.update(dt);
    framePlaying = tl.playing;
    renderer.render(scene, camera);
    // In VR, Spark sorts splats on a timer between frames and then restores whatever render target was current. After a
    // VR frame that is the headset's frame surface, which expires with the frame, so the restore fails with a WebGL
    // INVALID_OPERATION about 120 times a second. Leave no target current; three sets the VR one again next frame.
    if (renderer.xr.isPresenting) renderer.setRenderTarget(null);
  });
  document.addEventListener("visibilitychange", () => {
    previous = 0;
    if (document.hidden) currentViewer.release();
  });
  addEventListener(
    "pagehide",
    () => {
      sceneOnly?.dispose();
      stageObserver.disconnect();
      renderer.setAnimationLoop(null);
      xr.dispose();
      audio?.dispose();
      currentViewer.dispose();
      spark.dispose();
      renderer.dispose();
    },
    { once: true },
  );
  session.attach(currentViewer);
  if (import.meta.env.DEV) {
    // Dev-only handles: multi-tab checks compare positionsAt(t) across tabs of one room; scripted screenshots use the rest.
    const probe = new THREE.Object3D();
    window.__memreplay = {
      viewer: currentViewer,
      session,
      memory,
      audio,
      scene,
      grid,
      guide,
      camera,
      renderer,
      xr,
      controls,
      follower,
      get adapter() {
        return session.adapter;
      },
      positionsAt: (t: number) =>
        Object.fromEntries(
          memory.objects.map((o) => {
            sampleTrack(currentViewer.timeline.track(o.definition.id, o.track, t), t, probe);
            return [o.definition.id, probe.position.toArray().map((v) => Math.round(v * 1e4) / 1e4)];
          }),
        ),
      takes: () =>
        currentViewer.timeline.branches.map((b) => ({
          id: b.id,
          parentId: b.parentId,
          name: b.name,
          forkTime: b.forkTime,
          frames: Object.fromEntries([...b.tracks].map(([id, frames]) => [id, frames.length])),
        })),
    };
  }
  window.dispatchEvent(new CustomEvent("memoryreplay:ready", { detail: currentViewer }));
}
element("reload").onclick = () => location.reload();
main().catch((error) => {
  sceneOnly?.show();
  console.error(error);
  loading.hidden = true;
  element("reload").hidden = false;
  status.textContent = `Could not load this memory: ${error instanceof Error ? error.message : String(error)}`;
  warning.hidden = false;
  warning.textContent = new URLSearchParams(location.search).has("import")
    ? "Open the library to import this scene again on this device."
    : "Check the manifest URL, asset URLs, and CORS access. The sample scene works without pipeline assets.";
});
