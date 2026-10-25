import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Viewer } from "./viewer.js";

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

/** Controller squeeze or hand pinch grabs. Trigger also operates the in-world timeline panel. */
export class XRInput {
  private controllers: THREE.XRTargetRaySpace[] = [];
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
  private previousButtons = new Map<string, boolean>();
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private lastLabel = "";
  private previousSnap = false;

  constructor(private renderer: THREE.WebGLRenderer, private rig: THREE.Group,
    private camera: THREE.PerspectiveCamera, private viewer: Viewer) {
    this.canvas.width = 1024; this.canvas.height = 256;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide }));
    this.panel.position.set(0, 1.95, -2);
    rig.add(this.panel); this.panel.visible = false;
    const handModels = new XRHandModelFactory();
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      this.controllers.push(controller); rig.add(controller);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -4)]),
        new THREE.LineBasicMaterial({ color: 0x8ce5dd, transparent: true, opacity: 0.65 }));
      controller.add(line);
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
      ++this.requestVersion; this.pressed.clear(); this.owner = null; viewer.release();
      this.sources.clear(); this.previousButtons.clear(); this.panel.visible = false;
    });
  }

  private ray(index: number): void {
    const controller = this.controllers[index]; controller.updateWorldMatrix(true, false);
    this.position.setFromMatrixPosition(controller.matrixWorld);
    this.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.set(this.position, this.direction);
  }

  private async start(index: number, allowUI: boolean): Promise<void> {
    if (this.pressed.has(index) || this.owner !== null) return;
    this.pressed.add(index); this.ray(index);
    if (allowUI) {
      const hit = this.raycaster.intersectObject(this.panel)[0];
      if (hit?.uv) {
        const x = hit.uv.x;
        if (x < 0.23) this.viewer.togglePlay();
        else if (x < 0.43) this.viewer.seek(this.viewer.timeline.time - 1);
        else if (x < 0.63) this.viewer.seek(this.viewer.timeline.time + 1);
        else if (x < 0.82) this.cycleBranch();
        else this.viewer.selectBranch("original");
        return;
      }
    }
    const hit = this.viewer.pick(this.raycaster);
    if (!hit) return;
    const version = ++this.requestVersion;
    if (!await this.viewer.grab(hit.object.userData.objectId)) return;
    if (!this.pressed.has(index) || version !== this.requestVersion) { this.viewer.release(); return; }
    this.owner = index;
    this.controllers[index].updateWorldMatrix(true, false);
    this.viewer.held!.root.updateWorldMatrix(true, false);
    this.relative.copy(this.controllers[index].matrixWorld).invert().multiply(this.viewer.held!.root.matrixWorld);
  }

  private end(index: number): void {
    this.pressed.delete(index);
    if (this.owner === index) { this.viewer.release(); this.owner = null; }
    else if (this.owner === null) { ++this.requestVersion; this.viewer.cancelPendingGrab(); }
  }

  private cycleBranch(): void {
    const timeline = this.viewer.timeline;
    const next = (timeline.branches.findIndex(b => b.id === timeline.activeId) + 1) % timeline.branches.length;
    this.viewer.selectBranch(timeline.branches[next].id);
  }

  update(dt: number): void {
    this.panel.visible = this.renderer.xr.isPresenting;
    if (!this.renderer.xr.isPresenting) return;
    if (this.owner !== null) {
      if (!this.viewer.held) this.owner = null;
      else {
        this.controllers[this.owner].updateWorldMatrix(true, false);
        this.matrix.copy(this.controllers[this.owner].matrixWorld).multiply(this.relative);
        this.matrix.decompose(this.position, this.rotation, this.scale);
        this.viewer.moveHeld(this.position, this.rotation, dt);
      }
    }
    let snap = 0;
    for (const [index, source] of this.sources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      if (source.handedness === "left") stickMove(this.rig, this.camera, x, y, dt * 1.5);
      else if (Math.abs(x) > 0.7) snap = Math.sign(x);
      for (const [button, action] of [[4, () => this.viewer.togglePlay()], [5, () => this.cycleBranch()]] as const) {
        const pressed = pad.buttons[button]?.pressed ?? false;
        const key = `${index}-${button}`;
        if (pressed && !this.previousButtons.get(key)) action();
        this.previousButtons.set(key, pressed);
      }
    }
    // Right stick: a 30° snap turn about the head; pushing right turns right (clockwise seen from above).
    if (snap && !this.previousSnap) snapTurn(this.rig, this.camera, -snap * Math.PI / 6);
    this.previousSnap = !!snap;
    const timeline = this.viewer.timeline;
    const label = `${timeline.playing ? "PAUSE" : "PLAY"}|${timeline.time.toFixed(1)}|${timeline.active.name}|${this.viewer.held?.definition.label ?? ""}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      const ctx = this.context;
      ctx.fillStyle = "#101e27"; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = "#a1ece0"; ctx.font = "bold 35px sans-serif";
      ctx.fillText(`memos · ${timeline.active.name} · ${timeline.time.toFixed(1)}s`, 28, 56);
      ctx.fillStyle = "#ffffff"; ctx.font = "28px sans-serif";
      [timeline.playing ? "PAUSE" : "PLAY", "−1 SEC", "+1 SEC", "TAKES", "ORIGINAL"].forEach((text, i) => ctx.fillText(text, 28 + i * 202, 140));
      ctx.fillStyle = "#bdcbd3"; ctx.font = "23px sans-serif";
      ctx.fillText(this.viewer.held ? "Release to throw" : "Pause, then squeeze or pinch an object. Trigger selects controls.", 28, 218);
      this.texture.needsUpdate = true;
    }
  }
}
