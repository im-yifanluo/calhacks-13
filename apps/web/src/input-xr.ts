import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Viewer } from "./viewer.js";
import { XRPanel, placePanel, runPlaybackAction, timelineFraction, type PanelAction } from "./xr-panel.js";

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

interface XROptions {
  notice: () => string;
  openLibrary: () => void;
  unlockAudio: () => void;
  preview?: boolean;
}
type Press = "select" | "squeeze";

export class XRInput {
  private controllers: THREE.XRTargetRaySpace[] = [];
  private sources = new Map<number, XRInputSource>();
  private owner: number | null = null;
  private pending: number | null = null;
  private pressed = new Map<number, Press>();
  private requestVersion = 0;
  private relative = new THREE.Matrix4();
  private raycaster = new THREE.Raycaster();
  private direction = new THREE.Vector3();
  private position = new THREE.Vector3();
  private rotation = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private matrix = new THREE.Matrix4();
  private previousButtons = new Map<string, boolean>();
  private panel = new XRPanel();
  private previousSnap = false;
  private recenterFrames = 0;
  private scrubbing: number | null = null;
  private scrubElapsed = 0;
  private lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private dots: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private outlines: THREE.Box3Helper[] = [];
  private cleanup: (() => void)[] = [];
  private previewPointer: number | null = null;

  constructor(private renderer: THREE.WebGLRenderer, private rig: THREE.Group,
    private camera: THREE.PerspectiveCamera, private viewer: Viewer, private options: XROptions) {
    rig.add(this.panel.mesh);
    const handModels = new XRHandModelFactory();
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      this.controllers.push(controller); rig.add(controller); rig.add(renderer.xr.getControllerGrip(index));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xbec8b4, transparent: true, opacity: 0.7, depthTest: false }));
      line.renderOrder = 1001; line.scale.z = 4; controller.add(line); this.lines.push(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0xb44827, depthTest: false }));
      dot.renderOrder = 1002; dot.visible = false; controller.add(dot); this.dots.push(dot);
      const outline = new THREE.Box3Helper(new THREE.Box3(), 0xe8b16d);
      for (const material of Array.isArray(outline.material) ? outline.material : [outline.material]) material.depthTest = false; outline.renderOrder = 999; outline.visible = false;
      viewer.memory.root.parent?.add(outline); this.outlines.push(outline);
      controller.addEventListener("connected", event => { this.sources.set(index, event.data); });
      controller.addEventListener("disconnected", () => { this.end(index); this.sources.delete(index); });
      controller.addEventListener("selectstart", () => { void this.start(index, "select"); });
      controller.addEventListener("selectend", () => this.end(index, "select"));
      controller.addEventListener("squeezestart", () => { void this.start(index, "squeeze"); });
      controller.addEventListener("squeezeend", () => this.end(index, "squeeze"));
      const hand = renderer.xr.getHand(index);
      hand.add(handModels.createHandModel(hand, "spheres")); rig.add(hand);
    }
    const start = () => { this.recenterFrames = 2; this.panel.compact = false; this.panel.help = false; };
    const end = () => { this.reset(); this.panel.mesh.visible = false; };
    const visibility = () => {
      if (renderer.xr.getSession()?.visibilityState !== "visible") this.reset();
    };
    let activeSession: XRSession | null = null;
    const bindVisibility = () => {
      activeSession = renderer.xr.getSession(); activeSession?.addEventListener("visibilitychange", visibility); start();
    };
    const unbindVisibility = () => { activeSession?.removeEventListener("visibilitychange", visibility); activeSession = null; end(); };
    renderer.xr.addEventListener("sessionstart", bindVisibility);
    renderer.xr.addEventListener("sessionend", unbindVisibility);
    this.cleanup.push(() => { unbindVisibility(); renderer.xr.removeEventListener("sessionstart", bindVisibility); renderer.xr.removeEventListener("sessionend", unbindVisibility); });
    if (options.preview) this.bindPreview();
    if (renderer.xr.isPresenting) bindVisibility();
  }

  private reset(): void {
    ++this.requestVersion; this.pending = null; this.pressed.clear(); this.owner = null;
    this.viewer.release(); this.scrubbing = null; this.previousButtons.clear(); this.previousSnap = false;
    this.panel.hover = null;
    this.outlines.forEach(outline => { outline.visible = false; });
    this.dots.forEach(dot => { dot.visible = false; });
  }

  private ray(index: number): void {
    const controller = this.controllers[index]; controller.updateWorldMatrix(true, false);
    this.position.setFromMatrixPosition(controller.matrixWorld);
    this.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.set(this.position, this.direction);
  }

  private grip(index: number): THREE.Object3D {
    const source = this.sources.get(index);
    const wrist = this.renderer.xr.getHand(index).joints["wrist"];
    if (source?.hand && wrist) return wrist;
    const grip = this.renderer.xr.getControllerGrip(index);
    return grip.visible ? grip : this.controllers[index];
  }

  private async start(index: number, press: Press): Promise<void> {
    if (this.pressed.has(index) || this.owner !== null || this.pending !== null || this.scrubbing !== null) return;
    this.options.unlockAudio();
    this.pressed.set(index, press); this.ray(index);
    const panelHit = this.panel.hit(this.raycaster);
    if (panelHit) {
      if (press === "select" && panelHit.region) {
        if (panelHit.region.action === "seek") this.scrubbing = index;
        this.activate(panelHit.region.action, timelineFraction(panelHit.uv.x));
      }
      return;
    }
    const hit = this.viewer.pick(this.raycaster);
    if (!hit) return;
    if (this.viewer.timeline.playing) { this.viewer.report("Pause the memory before grabbing an object."); return; }
    const version = ++this.requestVersion; this.pending = index;
    const acquired = await this.viewer.grab(hit.object.userData.objectId);
    if (version === this.requestVersion && this.pending === index) this.pending = null;
    if (!acquired) return;
    if (!this.pressed.has(index) || version !== this.requestVersion) { this.viewer.release(); return; }
    this.owner = index;
    const grip = this.grip(index); grip.updateWorldMatrix(true, false);
    this.viewer.held!.root.updateWorldMatrix(true, false);
    this.relative.copy(grip.matrixWorld).invert().multiply(this.viewer.held!.root.matrixWorld);
    const haptic = this.sources.get(index)?.gamepad?.hapticActuators?.[0];
    void haptic?.pulse(0.35, 35).catch(() => {});
  }

  private end(index: number, press?: Press): void {
    if (press && this.pressed.get(index) !== press) return;
    if (this.scrubbing === index) { this.ray(index); this.seekFromRay(); this.scrubbing = null; }
    this.pressed.delete(index);
    if (this.owner === index) { this.viewer.release(); this.owner = null; }
    else if (this.pending === index) { ++this.requestVersion; this.pending = null; this.viewer.cancelPendingGrab(); }
  }

  private activate(action: PanelAction, fraction = 0): void {
    if (this.pending !== null || this.owner !== null) return;
    switch (action) {
      case "collapse": this.panel.compact = true; break;
      case "expand": this.panel.compact = false; break;
      case "help": this.panel.help = !this.panel.help; break;
      case "recenter": placePanel(this.panel.mesh, this.camera); break;
      case "library":
      case "exit": {
        const session = this.renderer.xr.getSession();
        const after = () => { if (action === "library") this.options.openLibrary(); };
        if (session) void session.end().then(after).catch(() => this.viewer.report("Could not leave VR. Use the headset menu to return to the browser."));
        else if (this.options.preview && action === "exit") location.search = "";
        else after();
        break;
      }
      default: runPlaybackAction(this.viewer, action, fraction);
    }
  }

  private seekFromRay(): void {
    const hit = this.panel.hit(this.raycaster);
    if (hit) this.activate("seek", timelineFraction(hit.uv.x));
  }

  update(dt: number): void {
    const presenting = this.renderer.xr.isPresenting;
    this.panel.mesh.visible = presenting || !!this.options.preview;
    if (!presenting) {
      if (this.options.preview) this.panel.draw(this.viewer, this.options.notice(), "");
      return;
    }
    if (this.recenterFrames > 0 && --this.recenterFrames === 0) placePanel(this.panel.mesh, this.camera);
    if (this.owner !== null) {
      if (!this.viewer.held) this.owner = null;
      else {
        const grip = this.grip(this.owner); grip.updateWorldMatrix(true, false);
        this.matrix.copy(grip.matrixWorld).multiply(this.relative);
        this.matrix.decompose(this.position, this.rotation, this.scale);
        this.viewer.moveHeld(this.position, this.rotation, dt);
      }
    }
    let snap = 0, target = "";
    this.panel.hover = null;
    this.scrubElapsed += dt;
    for (let index = 0; index < this.controllers.length; index++) {
      const source = this.sources.get(index);
      this.lines[index].visible = !!source;
      this.dots[index].visible = false; this.outlines[index].visible = false;
      if (!source || !this.controllers[index].visible) continue;
      this.ray(index);
      const panelHit = this.panel.hit(this.raycaster);
      const objectHit = panelHit ? undefined : this.viewer.pick(this.raycaster);
      const distance = panelHit?.distance ?? objectHit?.distance ?? 4;
      this.lines[index].scale.z = distance;
      this.lines[index].material.color.set(panelHit?.region || objectHit ? 0xe8b16d : 0xbec8b4);
      if (panelHit?.region || objectHit) {
        const dot = this.dots[index]; dot.position.set(0, 0, -distance); dot.visible = true;
        if (panelHit?.region) this.panel.hover = panelHit.region.action;
        if (objectHit && this.owner === null) {
          const object = this.viewer.memory.objects.find(o => o.definition.id === objectHit.object.userData.objectId);
          target = object?.definition.label ?? "Object";
          this.outlines[index].box.setFromObject(objectHit.object); this.outlines[index].visible = true;
        }
      }
      if (this.scrubbing === index && this.scrubElapsed >= 1 / 15) { this.seekFromRay(); this.scrubElapsed = 0; }
      const pad = source.gamepad;
      if (!pad) continue;
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      // Moving the rig during a throw would inject locomotion into the object's release velocity.
      const canMove = this.owner === null && this.pending === null && this.scrubbing === null;
      if (canMove && source.handedness === "left") stickMove(this.rig, this.camera, x, y, dt * 1.5);
      else if (canMove && source.handedness === "right" && Math.abs(x) > 0.7) snap = Math.sign(x);
      for (const button of [3, 4, 5]) {
        const pressed = pad.buttons[button]?.pressed ?? false, key = `${index}-${button}`;
        if (pressed && !this.previousButtons.get(key) && canMove) {
          this.options.unlockAudio();
          if (button === 4) this.activate("play");
          else if (button === 5) { this.panel.compact = !this.panel.compact; if (!this.panel.compact) placePanel(this.panel.mesh, this.camera); }
          else if (source.handedness === "right") { this.panel.compact = false; placePanel(this.panel.mesh, this.camera); }
        }
        this.previousButtons.set(key, pressed);
      }
    }
    if (snap && !this.previousSnap) snapTurn(this.rig, this.camera, -snap * Math.PI / 6);
    this.previousSnap = !!snap;
    this.panel.draw(this.viewer, this.options.notice(), target);
  }

  private bindPreview(): void {
    placePanel(this.panel.mesh, this.camera); this.panel.mesh.visible = true;
    const canvas = this.renderer.domElement;
    const ray = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), this.camera);
      return this.panel.hit(this.raycaster);
    };
    const down = (event: PointerEvent) => {
      const hit = ray(event);
      if (!hit) return;
      event.stopImmediatePropagation(); this.options.unlockAudio();
      if (!hit.region) return;
      if (hit.region.action === "seek") { this.previewPointer = event.pointerId; canvas.setPointerCapture(event.pointerId); }
      this.activate(hit.region.action, timelineFraction(hit.uv.x));
    };
    const move = (event: PointerEvent) => {
      const hit = ray(event); this.panel.hover = hit?.region?.action ?? null;
      if (this.previewPointer === event.pointerId) { event.stopImmediatePropagation(); if (hit) this.activate("seek", timelineFraction(hit.uv.x)); }
    };
    const end = (event: PointerEvent) => {
      if (this.previewPointer !== event.pointerId) return;
      this.previewPointer = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      event.stopImmediatePropagation();
    };
    canvas.addEventListener("pointerdown", down, true); canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", end, true); canvas.addEventListener("pointercancel", end, true);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", end, true); canvas.removeEventListener("pointercancel", end, true);
    });
  }

  dispose(): void {
    this.cleanup.forEach(dispose => dispose()); this.panel.dispose();
    for (const object of [...this.lines, ...this.dots, ...this.outlines]) {
      object.removeFromParent(); object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    }
  }
}
