import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Viewer } from "./viewer.js";
import { scrubTime, VRPanel, type PanelAction, type PanelHit } from "./vr-panel.js";

// Head pose for locomotion: use the user camera (main.ts parents it to the rig), never renderer.xr.getCamera().
// three's XR camera has no parent, and WebXRManager writes the raw viewer pose (in the reference space, i.e. relative
// to the rig) into its matrix, position and quaternion every frame. getWorldDirection/getWorldPosition on it rebuild
// matrixWorld from that local pose alone, so they ignore the rig's spawn yaw, earlier snap turns and stick moves:
// the stick walks in the wrong direction once the rig has turned, and the snap-turn head correction is always zero.
// WebXRManager.updateCamera writes the same head pose into the user camera relative to its parent on every render,
// so the user camera's world matrix is rig.matrixWorld × head pose: the head in the world, one frame old.
const up = new THREE.Vector3(0, 1, 0);
const headBefore = new THREE.Vector3(), headAfter = new THREE.Vector3(), right = new THREE.Vector3();
const headRotation = new THREE.Quaternion(), heading = new THREE.Euler();

/** The head's horizontal forward in world space (unit length), from its yaw, so it stays defined looking straight down. */
export function headForward(head: THREE.Object3D, out = new THREE.Vector3()): THREE.Vector3 {
  heading.setFromQuaternion(head.getWorldQuaternion(headRotation), "YXZ");
  return out.set(-Math.sin(heading.y), 0, -Math.cos(heading.y));
}

/** The same, in the head's parent space (the rig), from its local rotation. */
function localForward(head: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  heading.setFromQuaternion(head.quaternion, "YXZ");
  return out.set(-Math.sin(heading.y), 0, -Math.cos(heading.y));
}

/** Turn the rig by `angle` radians about the vertical axis through the head, so the head does not move. */
export function snapTurn(rig: THREE.Object3D, head: THREE.Object3D, angle: number): void {
  head.getWorldPosition(headBefore);
  rig.rotateOnWorldAxis(up, angle); rig.updateMatrixWorld(true);
  head.getWorldPosition(headAfter);
  rig.position.add(headBefore.sub(headAfter)); rig.updateMatrixWorld(true);
}

/** Left stick: pushing forward (negative y) walks along the head's horizontal forward, x strafes to its right. 0.2 dead zone. */
export function stickMove(rig: THREE.Object3D, head: THREE.Object3D, x: number, y: number, distance: number): void {
  const forward = headForward(head);
  right.crossVectors(forward, up);
  if (Math.abs(y) > 0.2) rig.position.addScaledVector(forward, -y * distance);
  if (Math.abs(x) > 0.2) rig.position.addScaledVector(right, x * distance);
}

/** What the page gives the headset controls. */
export interface XRHost {
  /** The latest status message (viewer, room and adapter messages all land there). */
  status(): string;
  /** "Solo", or the room code and its people. */
  room(): string;
  /** The memory's title. */
  title(): string;
  /** Stretches where the recording lost tracking, [from, to] seconds. */
  gaps(): [number, number][];
  /** Presses in VR are user gestures: let the memory's audio start. */
  unlockAudio(): void;
}

type Press = "select" | "squeeze";
type Pointing = PanelHit | { kind: "object"; id: string; distance: number; point: THREE.Vector3 } | null;

/** How long a new status message stays on the panel before the contextual hint comes back. */
const MESSAGE_MS = 6000;
/** Ray colours, the short idle beam and how far rays reach, m (the design brief: 0.35 m beam, 10 m hit test). */
const RAY = { idle: 0x8ce5dd, panel: 0xf2f5f7, object: 0xffd27a, short: 0.35, reach: 10 };
/** Controller buzzes, [intensity, ms]: hover is a tick, a grab has weight, a release is the grab at lower strength. */
const HAPTIC = {
  hover: [0.15, 10], grabbable: [0.2, 12], press: [0.5, 25], grab: [0.8, 40], release: [0.35, 20],
} as const satisfies Record<string, readonly [number, number]>;
/** Scrubbing seeks at most this often (each seek is a clock update to a shared room). */
const SCRUB_HZ = 15;

/** A short controller buzz; hands and controllers without a haptic actuator do nothing. */
function pulse(source: XRInputSource | undefined, [intensity, ms]: readonly [number, number]): void {
  const pad = source?.gamepad as (Gamepad & { hapticActuators?: { pulse?: (value: number, duration: number) => Promise<boolean> }[] }) | undefined;
  if (!pad) return;
  try {
    const actuator = pad.hapticActuators?.[0];
    if (actuator?.pulse) { void actuator.pulse(intensity, ms).catch(() => {}); return; }
    const vibration = (pad as unknown as { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }).vibrationActuator;
    void vibration?.playEffect?.("dual-rumble", { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity })?.catch(() => {});
  } catch { /* haptics are a nicety */ }
}

/** Dev builds keep the last 300 headset events in window.__vrlog, to read back over DevTools after a headset test. */
const LOG_SIZE = 300;
function vrlog(event: string, data: Record<string, unknown> = {}): void {
  if (!import.meta.env?.DEV || typeof window === "undefined") return;
  const log = ((window as unknown as { __vrlog?: unknown[] }).__vrlog ??= []);
  log.push({ t: Math.round(performance.now()), event, ...data });
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
}
const round = (v: THREE.Vector3) => v.toArray().map(x => Math.round(x * 100) / 100);

/** Two buzzes 90 ms apart: rising for a new take, falling for "not now". */
function pattern(source: XRInputSource | undefined, rising: boolean): void {
  const [first, second] = rising ? [0.3, 0.7] : [0.7, 0.3];
  pulse(source, [first, 40]);
  setTimeout(() => pulse(source, [second, 40]), 90);
}

/**
 * Quest controllers and hands. Grip or pinch grabs a paused object; the trigger (or a pinch) operates the panel and
 * drags it by the bar under it. Each ray stops at what it points at, with a cursor dot, and turns warm over an object
 * you can grab, which glows. Controllers buzz on hover, press, grab and throw.
 */
export class XRInput {
  private controllers: THREE.XRTargetRaySpace[] = [];
  private lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private cursors: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  /** What each controller pointed at last frame ("panel:play", "object:ball-1", ""), to buzz once on a change. */
  private pointingKeys = ["", ""];
  private sources = new Map<number, XRInputSource>();
  /** The controller holding an object, and the one whose grab request is still waiting on the room. */
  private owner: number | null = null;
  private pending: number | null = null;
  /** Each controller's press, so letting go of the trigger never ends a grip hold (and the other way round). */
  private pressed = new Map<number, Press>();
  private requestVersion = 0;
  private relative = new THREE.Matrix4();
  private raycaster = new THREE.Raycaster();
  private direction = new THREE.Vector3();
  private position = new THREE.Vector3();
  private rotation = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private matrix = new THREE.Matrix4();
  private head = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private gaze = new THREE.Vector3();
  private summonShown = false;
  private eye = new THREE.Vector3();
  private previousButtons = new Map<string, boolean>();
  private previousSnap = false;
  private panel: VRPanel;
  private scrubbing: number | null = null;
  private scrubElapsed = 0;
  private dragging: number | null = null;
  /** Frames to wait after entering VR before placing the panel, until the headset has reported a head pose. */
  private settle = 0;
  private highlights = new Map<string, THREE.Mesh>();
  private highlightMaterial = new THREE.MeshBasicMaterial({ color: RAY.object, transparent: true, opacity: 0.22, depthWrite: false });
  private toast: { text: string; until: number } | null = null;
  private lastStatus = "";
  private statusSince = 0;
  private wasRecording = false;
  private lastReleased: number | null = null;
  private cleanup: (() => void)[] = [];

  /** Dev preview (?xrPreview): the panel on the desktop canvas, worked with the mouse. */
  private preview: { canvas: HTMLCanvasElement; pointer: number | null; kind: "press" | "scrub" | "drag" | null } | null = null;

  constructor(private renderer: THREE.WebGLRenderer, private rig: THREE.Group,
    private camera: THREE.PerspectiveCamera, private viewer: Viewer, private host: XRHost, previewCanvas?: HTMLCanvasElement) {
    this.raycaster.far = RAY.reach;
    this.panel = new VRPanel(rig, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
    const handModels = new XRHandModelFactory();
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      this.controllers.push(controller); rig.add(controller); rig.add(renderer.xr.getControllerGrip(index));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: RAY.idle, transparent: true, opacity: 0.35, depthTest: false }));
      line.renderOrder = 1012; line.scale.z = RAY.short; controller.add(line); this.lines.push(line);
      const cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: RAY.idle, depthTest: false, transparent: true }));
      cursor.renderOrder = 1013; cursor.visible = false; (rig.parent ?? rig).add(cursor); this.cursors.push(cursor);
      controller.addEventListener("connected", event => {
        this.sources.set(index, event.data); vrlog("connected", { index, side: event.data.handedness, hand: !!event.data.hand });
      });
      controller.addEventListener("disconnected", () => { vrlog("disconnected", { index }); this.end(index); this.sources.delete(index); });
      controller.addEventListener("selectstart", () => { void this.start(index, "select"); });
      controller.addEventListener("selectend", () => this.end(index, "select"));
      controller.addEventListener("squeezestart", () => { void this.start(index, "squeeze"); });
      controller.addEventListener("squeezeend", () => this.end(index, "squeeze"));
      const hand = renderer.xr.getHand(index);
      hand.add(handModels.createHandModel(hand, "spheres")); rig.add(hand);
    }
    // Opening the system menu (or the headset going to sleep) drops whatever you were doing.
    const visibility = () => {
      const state = renderer.xr.getSession()?.visibilityState; vrlog("visibility", { state });
      if (state !== "visible") this.reset();
    };
    let session: XRSession | null = null;
    const started = () => {
      vrlog("sessionstart");
      session = renderer.xr.getSession(); session?.addEventListener("visibilitychange", visibility);
      this.reset(); this.panel.reset(); this.settle = 3;
    };
    const ended = () => {
      vrlog("sessionend");
      session?.removeEventListener("visibilitychange", visibility); session = null;
      this.reset(); this.sources.clear(); this.panel.reset();
    };
    renderer.xr.addEventListener("sessionstart", started);
    renderer.xr.addEventListener("sessionend", ended);
    this.cleanup.push(() => { ended(); renderer.xr.removeEventListener("sessionstart", started); renderer.xr.removeEventListener("sessionend", ended); });
    if (renderer.xr.isPresenting) started();
    if (previewCanvas) this.bindPreview(previewCanvas);
  }

  /** Let go of everything: the held object, a pending grab, presses, scrubbing and dragging. */
  private reset(): void {
    ++this.requestVersion; this.pending = null; this.pressed.clear(); this.owner = null; this.scrubbing = null;
    this.viewer.release(); this.previousButtons.clear(); this.previousSnap = false;
    if (this.dragging !== null) { this.panel.endDrag(); this.dragging = null; }
    this.panel.hover = null; this.panel.pressed = null; this.pointingKeys = ["", ""];
    this.cursors.forEach(cursor => { cursor.visible = false; }); this.highlight(null);
  }

  private ray(index: number): void {
    const controller = this.controllers[index]; controller.updateWorldMatrix(true, false);
    this.position.setFromMatrixPosition(controller.matrixWorld);
    this.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.set(this.position, this.direction);
  }

  /** Where a held object hangs from: the hand's wrist when tracking hands, else the controller grip (or its ray). */
  private grip(index: number): THREE.Object3D {
    const wrist = this.renderer.xr.getHand(index).joints?.["wrist"];
    if (this.sources.get(index)?.hand && wrist) return wrist;
    const grip = this.renderer.xr.getControllerGrip(index);
    return grip.visible ? grip : this.controllers[index];
  }

  /** What controller `index` points at: the panel (or its bar), a grabbable object (only while paused), or nothing. */
  private aim(index: number): Pointing {
    this.ray(index);
    const ui = this.panel.hit(this.raycaster);
    const paused = !this.viewer.timeline.playing && !this.viewer.held;
    const objectHit = paused ? this.viewer.pick(this.raycaster) : undefined;
    if (ui && (!objectHit || ui.distance <= objectHit.distance)) return ui;
    if (objectHit) return { kind: "object", id: objectHit.object.userData.objectId as string, distance: objectHit.distance, point: objectHit.point };
    return null;
  }

  private get busy(): boolean {
    return this.owner !== null || this.pending !== null || this.scrubbing !== null || this.dragging !== null;
  }

  private async start(index: number, press: Press): Promise<void> {
    if (this.pressed.has(index)) return;
    this.host.unlockAudio();
    this.pressed.set(index, press);
    if (this.busy) return;
    const source = this.sources.get(index);
    const pointing = this.aim(index);
    vrlog("press", { index, press, at: !pointing ? "nothing" : pointing.kind === "panel" ? `panel:${pointing.action ?? "glass"}` : pointing.kind === "bar" ? "bar" : `object:${pointing.id}` });
    if (pointing?.kind === "bar") {
      this.dragging = index; this.panel.beginDrag(this.raycaster.ray, pointing.point); pulse(source, HAPTIC.press);
      vrlog("drag-start", { index, panel: round(this.panel.mesh.getWorldPosition(new THREE.Vector3())) });
      return;
    }
    if (pointing?.kind === "panel") {
      // A grip on the panel does nothing, and nothing behind the panel is grabbed through it.
      if (press === "select" && pointing.action) { this.panel.pressed = pointing.action; pulse(source, HAPTIC.press); this.act(pointing.action, pointing.u, index); }
      return;
    }
    this.ray(index);
    const hit = this.viewer.pick(this.raycaster);
    if (!hit) return;
    if (this.viewer.timeline.playing) { this.say("Pause first (A or X), then grab."); pattern(source, false); return; }
    const version = ++this.requestVersion; this.pending = index;
    const acquired = await this.viewer.grab(hit.object.userData.objectId);
    if (version === this.requestVersion && this.pending === index) this.pending = null;
    if (!acquired) return;
    // Let go (or left VR) while the room was deciding: give it straight back.
    if (!this.pressed.has(index) || version !== this.requestVersion) { this.viewer.release(); return; }
    this.owner = index; pulse(source, HAPTIC.grab);
    const grip = this.grip(index); grip.updateWorldMatrix(true, false);
    this.viewer.held!.root.updateWorldMatrix(true, false);
    this.relative.copy(grip.matrixWorld).invert().multiply(this.viewer.held!.root.matrixWorld);
  }

  private end(index: number, press?: Press): void {
    if (press && this.pressed.get(index) !== press) return;
    this.pressed.delete(index);
    if (this.dragging === index) {
      this.panel.endDrag(); this.dragging = null; pulse(this.sources.get(index), HAPTIC.release);
      const at = this.panel.mesh.getWorldPosition(new THREE.Vector3()), eye = this.camera.getWorldPosition(new THREE.Vector3());
      const d = at.clone().sub(eye);
      vrlog("drag-end", { index, panel: round(at), eye: round(eye), distance: Math.round(d.length() * 100) / 100,
        pitchDeg: Math.round(Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI) });
    }
    if (this.scrubbing === index) { this.scrub(index); this.scrubbing = null; }
    if (this.panel.pressed && this.pressed.size === 0) this.panel.pressed = null;
    if (this.owner === index) {
      this.viewer.release(); this.owner = null; this.lastReleased = index; pulse(this.sources.get(index), HAPTIC.release);
    } else if (this.pending === index) { ++this.requestVersion; this.pending = null; this.viewer.cancelPendingGrab(); }
  }

  /** Seek to where controller `index` points on the scrubber, if it still points at the panel. */
  private scrub(index: number): void {
    this.ray(index);
    const hit = this.panel.hit(this.raycaster);
    if (hit?.kind === "panel") this.viewer.seek(scrubTime(hit.u, this.viewer.timeline.duration));
  }

  private act(action: PanelAction, u: number, index: number): void {
    const viewer = this.viewer, timeline = viewer.timeline;
    vrlog("action", { action, index });
    switch (action) {
      case "play": viewer.togglePlay(); break;
      case "back": viewer.seek(timeline.time - 1); break;
      case "forward": viewer.seek(timeline.time + 1); break;
      case "scrub": this.scrubbing = index; this.scrubElapsed = 0; viewer.seek(scrubTime(u, timeline.duration)); break;
      case "prev-take": this.cycleBranch(-1); break;
      case "next-take": this.cycleBranch(1); break;
      case "original": viewer.selectBranch("original"); break;
      case "help": this.panel.mode = this.panel.mode === "help" ? "full" : "help"; break;
      case "hide": this.panel.mode = "compact"; break;
      case "show": this.panel.mode = "full"; break;
      case "exit": void this.renderer.xr.getSession()?.end().catch(() => this.say("Use the headset's menu to leave VR.")); break;
      case "summon": if (this.panel.mode === "compact") this.panel.mode = "full"; this.panel.recenter(); break;
    }
  }

  /** B or Y: hide the panel, or bring it back in front of you. */
  private toggleHidden(): void {
    if (this.panel.mode === "compact") { this.panel.mode = "full"; this.panel.recenter(); }
    else this.panel.mode = "compact";
  }

  private cycleBranch(step = 1): void {
    const timeline = this.viewer.timeline, count = timeline.branches.length;
    if (count < 2) return;
    const next = (timeline.branches.findIndex(b => b.id === timeline.activeId) + step + count) % count;
    this.viewer.selectBranch(timeline.branches.at(next)!.id);
  }

  /** Show a message on the panel for a few seconds. */
  private say(text: string): void { this.toast = { text, until: performance.now() + 2500 }; }

  /** Glow on the object a ray points at, built from its invisible pick proxy the first time. */
  private highlight(id: string | null): void {
    for (const [objectId, mesh] of this.highlights) mesh.visible = objectId === id;
    if (!id || this.highlights.has(id)) return;
    const proxy = this.viewer.pickables.find(p => p.userData.objectId === id);
    if (!proxy?.parent) return;
    const glow = new THREE.Mesh(proxy.geometry, this.highlightMaterial);
    glow.position.copy(proxy.position); glow.quaternion.copy(proxy.quaternion); glow.scale.copy(proxy.scale).multiplyScalar(1.08);
    glow.renderOrder = 999; glow.raycast = () => {}; proxy.parent.add(glow); this.highlights.set(id, glow);
  }

  private statusLine(now: number, target: string): string {
    if (this.toast && now < this.toast.until) return this.toast.text;
    const status = this.host.status();
    if (status !== this.lastStatus) { this.lastStatus = status; this.statusSince = now; }
    if (status && now - this.statusSince < MESSAGE_MS) return status;
    const viewer = this.viewer;
    if (this.dragging !== null) return "Move the panel; the stick pushes it away or pulls it closer.";
    if (viewer.held) return `Holding ${viewer.held.definition.label}. Move, then let go to throw.`;
    if (viewer.recording) return "Recording the throw…";
    if (target) return `${target}: hold grip or pinch to grab.`;
    if (viewer.timeline.playing) return "Press A or X to pause, then grab something.";
    return "Point at an object and hold grip to grab it.";
  }

  update(dt: number): void {
    if (!this.renderer.xr.isPresenting) { if (this.preview) this.previewFrame(dt); return; }
    const viewer = this.viewer;
    if (this.owner !== null) {
      if (!viewer.held) this.owner = null;
      else {
        const grip = this.grip(this.owner); grip.updateWorldMatrix(true, false);
        this.matrix.copy(grip.matrixWorld).multiply(this.relative);
        this.matrix.decompose(this.position, this.rotation, this.scale);
        viewer.moveHeld(this.position, this.rotation, dt);
      }
    }
    // The throw's recording just finished, so the new take is saved: a rising double buzz on the hand that threw.
    if (this.wasRecording && !viewer.recording && !viewer.held && this.lastReleased !== null) pattern(this.sources.get(this.lastReleased), true);
    this.wasRecording = viewer.recording;

    // Sticks and buttons. Moving the rig while holding, scrubbing or dragging would add to the throw or shift the panel.
    let snap = 0, push = 0;
    for (const [index, source] of this.sources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      if (this.dragging === index) push = -y;
      else if (!this.busy && source.handedness === "left") stickMove(this.rig, this.camera, x, y, dt * 1.5);
      else if (!this.busy && Math.abs(x) > 0.7) snap = Math.sign(x);
      for (const button of [3, 4, 5]) {
        const down = pad.buttons[button]?.pressed ?? false, key = `${index}-${button}`;
        if (down && !this.previousButtons.get(key) && !this.busy) {
          this.host.unlockAudio();
          vrlog("button", { index, side: source.handedness, button });
          if (button === 4) { viewer.togglePlay(); pulse(source, HAPTIC.press); }
          else if (button === 5) { this.toggleHidden(); pulse(source, HAPTIC.press); }
          else if (source.handedness === "right") { this.panel.mode = this.panel.mode === "help" ? "help" : "full"; this.panel.recenter(); pulse(source, HAPTIC.press); }
        }
        this.previousButtons.set(key, down);
      }
    }
    // Right stick: a 30° snap turn about the head; pushing right turns right (clockwise seen from above).
    if (snap && !this.previousSnap) snapTurn(this.rig, this.camera, -snap * Math.PI / 6);
    this.previousSnap = !!snap;

    // Rays, cursors, hover and scrubbing.
    let hover: PanelAction | "bar" | null = null, glow: string | null = null, target = "", onPanel = false;
    for (let index = 0; index < this.controllers.length; index++) {
      const line = this.lines[index], cursor = this.cursors[index];
      const active = this.sources.has(index) && this.owner !== index && this.settle === 0;
      line.visible = active;
      if (!active) { cursor.visible = false; this.pointingKeys[index] = ""; continue; }
      const pointing = this.dragging === index ? null : this.aim(index);
      const interactive = pointing && (pointing.kind !== "panel" || pointing.action !== null);
      line.scale.z = pointing ? pointing.distance : RAY.short;
      line.material.color.setHex(pointing?.kind === "object" ? RAY.object : pointing ? RAY.panel : RAY.idle);
      line.material.opacity = interactive ? 0.9 : pointing ? 0.6 : 0.35;
      cursor.visible = !!pointing;
      if (pointing) {
        // About 1° across at any distance, 83 % while pressed.
        cursor.position.copy(pointing.point);
        cursor.scale.setScalar(pointing.distance * 0.009 * (this.pressed.has(index) ? 0.83 : 1));
        cursor.material.color.copy(line.material.color);
      }
      if (pointing?.kind !== "object" && pointing) onPanel = true;
      const key = !pointing ? "" : pointing.kind === "panel" ? `panel:${pointing.action ?? ""}` : pointing.kind === "bar" ? "bar" : `object:${pointing.id}`;
      if (key !== this.pointingKeys[index] && interactive) pulse(this.sources.get(index), pointing.kind === "object" ? HAPTIC.grabbable : HAPTIC.hover);
      this.pointingKeys[index] = key;
      if (pointing?.kind === "panel" && pointing.action) hover ??= pointing.action;
      if (pointing?.kind === "bar") hover ??= "bar";
      if (pointing?.kind === "object") {
        glow ??= pointing.id;
        target ||= viewer.memory.objects.find(o => o.definition.id === pointing.id)?.definition.label ?? "";
      }
    }
    this.panel.hover = this.dragging !== null ? "bar" : hover;
    this.highlight(glow);
    this.scrubElapsed += dt;
    if (this.scrubbing !== null && this.scrubElapsed >= 1 / SCRUB_HZ) { this.scrub(this.scrubbing); this.scrubElapsed = 0; }

    // The panel: dragged by the bar, or following lazily (frozen while you point at it or scrub).
    this.camera.updateWorldMatrix(true, false);
    this.camera.getWorldPosition(this.eye);
    if (this.settle > 0) { this.settle--; this.panel.mesh.visible = false; }
    else if (this.dragging !== null) { this.ray(this.dragging); this.panel.dragTo(this.raycaster.ray, this.eye, push, dt); }
    else this.panel.follow(this.head.copy(this.camera.position), localForward(this.camera, this.forward), dt, onPanel || this.scrubbing !== null);
    if (this.settle === 0) {
      this.gaze.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.panel.updateSummon(this.head.copy(this.camera.position), localForward(this.camera, this.forward), this.gaze, dt);
      if (this.panel.summon.visible !== this.summonShown) { this.summonShown = this.panel.summon.visible; vrlog(this.summonShown ? "summon-shown" : "summon-hidden"); }
    }
    this.panel.setDimmed(!!viewer.held || viewer.recording);
    this.drawPanel(target);
  }

  private drawPanel(target: string): void {
    const viewer = this.viewer, timeline = viewer.timeline, branches = timeline.branches;
    const forks: number[] = [];
    for (let branch = timeline.active; branch.parentId !== null;) {
      forks.push(branch.forkTime);
      const parent = branches.find(b => b.id === branch.parentId);
      if (!parent) break;
      branch = parent;
    }
    this.panel.draw({
      title: this.host.title(), playing: timeline.playing, time: timeline.time, duration: timeline.duration,
      take: timeline.active.id === "original" ? "Original recording" : timeline.active.name,
      takeIndex: Math.max(0, branches.findIndex(b => b.id === timeline.activeId)), takeCount: branches.length, forks,
      gaps: this.host.gaps(), status: this.statusLine(performance.now(), target), room: this.host.room(), holding: !!viewer.held,
    });
  }

  /** Desktop preview: the panel stays 1.2 m in front of the (still) camera and the mouse works it like a ray. */
  private previewFrame(dt: number): void {
    this.panel.follow(this.head.copy(this.camera.position), localForward(this.camera, this.forward), dt, this.panel.hover !== null);
    this.drawPanel("");
  }

  private bindPreview(canvas: HTMLCanvasElement): void {
    const preview = this.preview = { canvas, pointer: null as number | null, kind: null as "press" | "scrub" | "drag" | null };
    const ndc = new THREE.Vector2();
    const ray = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      ndc.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
      this.raycaster.setFromCamera(ndc, this.camera);
      return this.panel.hit(this.raycaster);
    };
    const eye = () => this.camera.getWorldPosition(this.eye);
    const down = (event: PointerEvent) => {
      const hit = ray(event);
      if (!hit) return;
      event.stopImmediatePropagation(); event.preventDefault(); this.host.unlockAudio();
      preview.pointer = event.pointerId; canvas.setPointerCapture(event.pointerId);
      if (hit.kind === "bar") { preview.kind = "drag"; this.panel.beginDrag(this.raycaster.ray, hit.point); return; }
      if (!hit.action) { preview.kind = "press"; return; }
      this.panel.pressed = hit.action;
      preview.kind = hit.action === "scrub" ? "scrub" : "press";
      if (hit.action === "scrub") this.viewer.seek(scrubTime(hit.u, this.viewer.timeline.duration));
      else this.act(hit.action, hit.u, -1);
    };
    const move = (event: PointerEvent) => {
      const hit = ray(event);
      if (preview.pointer !== event.pointerId) { this.panel.hover = hit?.kind === "bar" ? "bar" : hit?.kind === "panel" ? hit.action : null; return; }
      event.stopImmediatePropagation();
      if (preview.kind === "drag") this.panel.dragTo(this.raycaster.ray, eye(), 0, 1 / 60);
      else if (preview.kind === "scrub" && hit?.kind === "panel") this.viewer.seek(scrubTime(hit.u, this.viewer.timeline.duration));
    };
    const up = (event: PointerEvent) => {
      if (preview.pointer !== event.pointerId) return;
      event.stopImmediatePropagation();
      if (preview.kind === "drag") this.panel.endDrag();
      preview.pointer = null; preview.kind = null; this.panel.pressed = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerdown", down, true); canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", up, true); canvas.addEventListener("pointercancel", up, true);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", up, true); canvas.removeEventListener("pointercancel", up, true);
    });
  }

  dispose(): void {
    this.cleanup.forEach(run => run()); this.panel.dispose();
    for (const object of [...this.lines, ...this.cursors]) { object.removeFromParent(); object.geometry.dispose(); object.material.dispose(); }
    for (const glow of this.highlights.values()) glow.removeFromParent();
    this.highlightMaterial.dispose();
  }
}
