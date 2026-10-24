import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Viewer } from "./viewer.js";

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
      if (source.handedness === "left") {
        this.renderer.xr.getCamera().getWorldDirection(this.direction); this.direction.y = 0; this.direction.normalize();
        if (Math.abs(y) > 0.2) this.rig.position.addScaledVector(this.direction, -y * dt * 1.5);
        if (Math.abs(x) > 0.2) this.rig.position.addScaledVector(this.position.crossVectors(this.direction, THREE.Object3D.DEFAULT_UP), x * dt * 1.5);
      } else if (Math.abs(x) > 0.7) snap = Math.sign(x);
      for (const [button, action] of [[4, () => this.viewer.togglePlay()], [5, () => this.cycleBranch()]] as const) {
        const pressed = pad.buttons[button]?.pressed ?? false;
        const key = `${index}-${button}`;
        if (pressed && !this.previousButtons.get(key)) action();
        this.previousButtons.set(key, pressed);
      }
    }
    if (snap && !this.previousSnap) {
      // Rotate around the user's head, avoiding a positional jump during snap turning.
      this.renderer.xr.getCamera().getWorldPosition(this.position);
      const before = this.position.clone();
      this.rig.rotateY(-snap * Math.PI / 6); this.rig.updateMatrixWorld(true);
      this.renderer.xr.getCamera().getWorldPosition(this.position);
      this.rig.position.add(before.sub(this.position));
    }
    this.previousSnap = !!snap;
    const timeline = this.viewer.timeline;
    const label = `${timeline.playing ? "PAUSE" : "PLAY"}|${timeline.time.toFixed(1)}|${timeline.active.name}|${this.viewer.held?.definition.label ?? ""}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      const ctx = this.context;
      ctx.fillStyle = "#101e27"; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = "#a1ece0"; ctx.font = "bold 35px sans-serif";
      ctx.fillText(`MEMORY REPLAY · ${timeline.active.name} · ${timeline.time.toFixed(1)}s`, 28, 56);
      ctx.fillStyle = "#ffffff"; ctx.font = "28px sans-serif";
      [timeline.playing ? "PAUSE" : "PLAY", "−1 SEC", "+1 SEC", "TAKES", "ORIGINAL"].forEach((text, i) => ctx.fillText(text, 28 + i * 202, 140));
      ctx.fillStyle = "#bdcbd3"; ctx.font = "23px sans-serif";
      ctx.fillText(this.viewer.held ? "Release to throw" : "Pause, then squeeze or pinch an object. Trigger selects controls.", 28, 218);
      this.texture.needsUpdate = true;
    }
  }
}
