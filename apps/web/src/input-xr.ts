import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Viewer } from "./viewer.js";
import { hitRegion, scrubTime, VRPanel, type PanelAction } from "./vr-panel.js";

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

/** Text the room and the 2D status line provide; the VR panel shows it. */
export interface XRStatusSource {
  /** The latest status message (viewer, room and adapter messages all land there). */
  status(): string;
  /** "Solo", or the room code and its people. */
  room(): string;
}

type Pointing = { kind: "panel"; action: PanelAction | null; u: number } | { kind: "object"; id: string } | null;

/** How long a new status message stays on the panel before the contextual hint comes back. */
const MESSAGE_MS = 6000;
const RAY = { idle: 0x8ce5dd, panel: 0xffffff, object: 0xffd27a, length: 4 };

/** A short controller buzz; hands and controllers without a haptic actuator do nothing. */
function pulse(source: XRInputSource | undefined, intensity: number, ms: number): void {
  const pad = source?.gamepad as (Gamepad & { hapticActuators?: { pulse?: (value: number, duration: number) => Promise<boolean> }[] }) | undefined;
  if (!pad) return;
  try {
    const actuator = pad.hapticActuators?.[0];
    if (actuator?.pulse) { void actuator.pulse(intensity, ms).catch(() => {}); return; }
    const vibration = (pad as unknown as { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }).vibrationActuator;
    void vibration?.playEffect?.("dual-rumble", { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity })?.catch(() => {});
  } catch { /* haptics are a nicety */ }
}

/**
 * Quest controllers and hands. Squeeze or pinch grabs a paused object; the trigger (or a pinch) operates the follow
 * panel. Each ray stops at what it points at, with a cursor dot, and turns warm over an object you can grab, which glows.
 * Controllers buzz on hover, press, grab and throw.
 */
export class XRInput {
  private controllers: THREE.XRTargetRaySpace[] = [];
  private lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private cursors: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  /** What each controller pointed at last frame ("panel:play", "object:ball-1", ""), to buzz once on a change. */
  private pointingKeys = ["", ""];
  private sources = new Map<number, XRInputSource>();
  private owner: number | null = null;
  private pressed = new Set<number>();
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
  private previousButtons = new Map<string, boolean>();
  private previousSnap = false;
  private panel: VRPanel;
  private scrubbing: number | null = null;
  private highlights = new Map<string, THREE.Mesh>();
  private highlightMaterial = new THREE.MeshBasicMaterial({ color: RAY.object, transparent: true, opacity: 0.22, depthWrite: false });
  private toast: { text: string; until: number } | null = null;
  private lastStatus = "";
  private statusSince = 0;

  constructor(private renderer: THREE.WebGLRenderer, private rig: THREE.Group,
    private camera: THREE.PerspectiveCamera, private viewer: Viewer, private text: XRStatusSource) {
    const world = rig.parent ?? rig;
    this.panel = new VRPanel(world);
    const handModels = new XRHandModelFactory();
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      this.controllers.push(controller); rig.add(controller);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: RAY.idle, transparent: true, opacity: 0.6 }));
      line.scale.z = RAY.length; controller.add(line); this.lines.push(line);
      const cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: RAY.idle, depthTest: false, transparent: true }));
      cursor.renderOrder = 1001; cursor.visible = false; world.add(cursor); this.cursors.push(cursor);
      controller.addEventListener("connected", event => { this.sources.set(index, event.data); });
      controller.addEventListener("disconnected", () => { this.end(index); this.sources.delete(index); });
      controller.addEventListener("selectstart", () => { void this.start(index, true); });
      controller.addEventListener("selectend", () => this.end(index));
      controller.addEventListener("squeezestart", () => { void this.start(index, false); });
      controller.addEventListener("squeezeend", () => this.end(index));
      const hand = renderer.xr.getHand(index);
      hand.add(handModels.createHandModel(hand, "spheres")); rig.add(hand);
    }
    renderer.xr.addEventListener("sessionend", () => {
      ++this.requestVersion; this.pressed.clear(); this.owner = null; this.scrubbing = null; viewer.release();
      this.sources.clear(); this.previousButtons.clear(); this.panel.reset(); this.panel.pressed = null;
      this.cursors.forEach(cursor => { cursor.visible = false; }); this.highlight(null);
    });
  }

  private ray(index: number): void {
    const controller = this.controllers[index]; controller.updateWorldMatrix(true, false);
    this.position.setFromMatrixPosition(controller.matrixWorld);
    this.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.set(this.position, this.direction);
  }

  /** What controller `index` points at: a panel region, a grabbable object (only while paused), or nothing. */
  private aim(index: number): { pointing: Pointing; distance: number; point: THREE.Vector3 | null } {
    this.ray(index);
    const panelHit = this.panel.mesh.visible ? this.raycaster.intersectObject(this.panel.mesh, false)[0] : undefined;
    const paused = !this.viewer.timeline.playing && !this.viewer.held;
    const objectHit = paused ? this.viewer.pick(this.raycaster) : undefined;
    if (panelHit?.uv && (!objectHit || panelHit.distance <= objectHit.distance))
      return { pointing: { kind: "panel", action: hitRegion(panelHit.uv.x, panelHit.uv.y), u: panelHit.uv.x }, distance: panelHit.distance, point: panelHit.point };
    if (objectHit) return { pointing: { kind: "object", id: objectHit.object.userData.objectId as string }, distance: objectHit.distance, point: objectHit.point };
    return { pointing: null, distance: RAY.length, point: null };
  }

  private async start(index: number, allowUI: boolean): Promise<void> {
    if (this.pressed.has(index) || this.owner !== null) return;
    this.pressed.add(index);
    const source = this.sources.get(index);
    const { pointing } = this.aim(index);
    if (pointing?.kind === "panel") {
      if (!allowUI) return; // a squeeze on the panel does nothing
      if (pointing.action) { this.panel.pressed = pointing.action; pulse(source, 0.35, 25); this.act(pointing.action, pointing.u, index); }
      return;
    }
    this.ray(index);
    const hit = this.viewer.pick(this.raycaster);
    if (!hit) return;
    if (this.viewer.timeline.playing) { this.say("Pause first: press A or X, then grab."); pulse(source, 0.2, 20); return; }
    const version = ++this.requestVersion;
    if (!await this.viewer.grab(hit.object.userData.objectId)) return;
    if (!this.pressed.has(index) || version !== this.requestVersion) { this.viewer.release(); return; }
    this.owner = index; pulse(source, 0.55, 35);
    this.controllers[index].updateWorldMatrix(true, false);
    this.viewer.held!.root.updateWorldMatrix(true, false);
    this.relative.copy(this.controllers[index].matrixWorld).invert().multiply(this.viewer.held!.root.matrixWorld);
  }

  private end(index: number): void {
    this.pressed.delete(index);
    if (this.scrubbing === index) this.scrubbing = null;
    if (this.panel.pressed && this.pressed.size === 0) this.panel.pressed = null;
    if (this.owner === index) { this.viewer.release(); this.owner = null; pulse(this.sources.get(index), 0.3, 25); }
    else if (this.owner === null) { ++this.requestVersion; this.viewer.cancelPendingGrab(); }
  }

  private act(action: PanelAction, u: number, index: number): void {
    const viewer = this.viewer, timeline = viewer.timeline;
    switch (action) {
      case "play": viewer.togglePlay(); break;
      case "back": viewer.seek(timeline.time - 1); break;
      case "forward": viewer.seek(timeline.time + 1); break;
      case "scrub": this.scrubbing = index; viewer.seek(scrubTime(u, timeline.duration)); break;
      case "prev-take": this.cycleBranch(-1); break;
      case "next-take": this.cycleBranch(1); break;
      case "original": viewer.selectBranch("original"); break;
    }
  }

  private cycleBranch(step = 1): void {
    const timeline = this.viewer.timeline, count = timeline.branches.length;
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

  private statusLine(now: number): string {
    if (this.toast && now < this.toast.until) return this.toast.text;
    const status = this.text.status();
    if (status !== this.lastStatus) { this.lastStatus = status; this.statusSince = now; }
    if (status && now - this.statusSince < MESSAGE_MS) return status;
    const viewer = this.viewer;
    if (viewer.held) return "Move, then let go to throw.";
    if (viewer.recording) return "Recording the throw…";
    if (viewer.timeline.playing) return "Press A or X to pause, then grab something.";
    return "Squeeze an object to grab it. Point at the panel and pull the trigger.";
  }

  update(dt: number): void {
    if (!this.renderer.xr.isPresenting) return;
    const viewer = this.viewer;
    if (this.owner !== null) {
      if (!viewer.held) this.owner = null;
      else {
        this.controllers[this.owner].updateWorldMatrix(true, false);
        this.matrix.copy(this.controllers[this.owner].matrixWorld).multiply(this.relative);
        this.matrix.decompose(this.position, this.rotation, this.scale);
        viewer.moveHeld(this.position, this.rotation, dt);
      }
    }
    let snap = 0;
    for (const [index, source] of this.sources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      if (source.handedness === "left") stickMove(this.rig, this.camera, x, y, dt * 1.5);
      else if (Math.abs(x) > 0.7) snap = Math.sign(x);
      for (const [button, action] of [[4, () => viewer.togglePlay()], [5, () => this.cycleBranch()]] as const) {
        const pressed = pad.buttons[button]?.pressed ?? false;
        const key = `${index}-${button}`;
        if (pressed && !this.previousButtons.get(key)) { action(); pulse(source, 0.25, 20); }
        this.previousButtons.set(key, pressed);
      }
    }
    // Right stick: a 30° snap turn about the head; pushing right turns right (clockwise seen from above).
    if (snap && !this.previousSnap) snapTurn(this.rig, this.camera, -snap * Math.PI / 6);
    this.previousSnap = !!snap;

    // The panel follows the head lazily (the head pose is one frame old, which is fine for this).
    this.camera.getWorldPosition(this.head); headForward(this.camera, this.forward);
    this.panel.follow(this.head, this.forward, dt);
    this.panel.setDimmed(!!viewer.held || viewer.recording);

    // Rays, cursors, hover and scrubbing.
    let hover: PanelAction | null = null, glow: string | null = null;
    for (let index = 0; index < this.controllers.length; index++) {
      const line = this.lines[index], cursor = this.cursors[index];
      const active = this.sources.has(index) && this.owner !== index;
      line.visible = active;
      if (!active) { cursor.visible = false; this.pointingKeys[index] = ""; continue; }
      const { pointing, distance, point } = this.aim(index);
      line.scale.z = distance;
      line.material.color.setHex(pointing?.kind === "panel" ? RAY.panel : pointing?.kind === "object" ? RAY.object : RAY.idle);
      line.material.opacity = pointing ? 0.9 : 0.5;
      cursor.visible = !!point;
      if (point) { cursor.position.copy(point); cursor.scale.setScalar(pointing?.kind === "panel" ? 0.006 : 0.014); cursor.material.color.copy(line.material.color); }
      const key = pointing ? (pointing.kind === "panel" ? `panel:${pointing.action ?? ""}` : `object:${pointing.id}`) : "";
      if (key !== this.pointingKeys[index] && pointing && (pointing.kind === "object" || pointing.action)) pulse(this.sources.get(index), 0.1, 12);
      this.pointingKeys[index] = key;
      if (pointing?.kind === "panel" && pointing.action) hover ??= pointing.action;
      if (pointing?.kind === "object") glow ??= pointing.id;
      if (this.scrubbing === index && pointing?.kind === "panel") viewer.seek(scrubTime(pointing.u, viewer.timeline.duration));
    }
    this.panel.hover = hover;
    this.highlight(glow);

    const timeline = viewer.timeline, branches = timeline.branches;
    const forks: number[] = [];
    for (let branch = timeline.active; branch.parentId !== null;) {
      forks.push(branch.forkTime);
      const parent = branches.find(b => b.id === branch.parentId);
      if (!parent) break;
      branch = parent;
    }
    this.panel.draw({
      playing: timeline.playing, time: timeline.time, duration: timeline.duration,
      take: timeline.active.id === "original" ? "Original recording" : timeline.active.name,
      takeIndex: Math.max(0, branches.findIndex(b => b.id === timeline.activeId)), takeCount: branches.length, forks,
      status: this.statusLine(performance.now()), room: this.text.room(), holding: !!viewer.held,
    });
  }
}
