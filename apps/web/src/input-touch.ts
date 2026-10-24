import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export interface TouchActions {
  paused(): boolean;
  grab(id: string): Promise<boolean>;
  move(id: string, position: THREE.Vector3): void;
  drop(id: string, velocity: THREE.Vector3): void;
}
export function flickVelocity(samples: { t: number; p: THREE.Vector3 }[]) {
  if (samples.length < 2) return new THREE.Vector3();
  const last = samples.at(-1)!,
    first = samples.find((s) => last.t - s.t <= 120) || samples[0];
  const dt = (last.t - first.t) / 1000;
  return dt > 0
    ? last.p.clone().sub(first.p).divideScalar(dt).clampLength(0, 8)
    : new THREE.Vector3();
}
export class TouchInput {
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private drag?: {
    id: string;
    pointerId: number;
    plane: THREE.Plane;
    offset: THREE.Vector3;
    last: THREE.Vector3;
    samples: { t: number; p: THREE.Vector3 }[];
    granted: boolean;
    ended: boolean;
    cancelled: boolean;
  };
  private stick = new THREE.Vector2();
  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.Camera,
    private orbit: OrbitControls,
    private targets: () => THREE.Object3D[],
    private actions: TouchActions,
    joystick: HTMLElement,
  ) {
    canvas.addEventListener("pointerdown", this.down, true);
    canvas.addEventListener("pointermove", this.move, true);
    canvas.addEventListener("pointerup", this.up, true);
    canvas.addEventListener("pointercancel", this.cancel, true);
    let stickId: number | undefined;
    const point = (e: PointerEvent) => {
      const r = joystick.getBoundingClientRect();
      this.stick
        .set(
          (e.clientX - r.left - r.width / 2) / (r.width / 2),
          (e.clientY - r.top - r.height / 2) / (r.height / 2),
        )
        .clampLength(0, 1);
    };
    joystick.onpointerdown = (e) => {
      stickId = e.pointerId;
      joystick.setPointerCapture(e.pointerId);
      point(e);
    };
    joystick.onpointermove = (e) => {
      if (stickId === e.pointerId) point(e);
    };
    joystick.onpointerup = joystick.onpointercancel = () => {
      stickId = undefined;
      this.stick.set(0, 0);
    };
  }
  private cast(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
  }
  private down = (e: PointerEvent) => {
    if (this.drag || !this.actions.paused() || e.button !== 0) return;
    this.cast(e);
    const hit = this.ray.intersectObjects(this.targets(), false)[0];
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.canvas.setPointerCapture(e.pointerId);
    this.orbit.enabled = false;
    const position = hit.object.position.clone(),
      normal = this.camera.getWorldDirection(new THREE.Vector3());
    const drag: NonNullable<TouchInput["drag"]> = (this.drag = {
      id: hit.object.name,
      pointerId: e.pointerId,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point),
      offset: position.clone().sub(hit.point),
      last: position,
      samples: [{ t: performance.now(), p: position.clone() }],
      granted: false,
      ended: false,
      cancelled: false,
    });
    void this.actions.grab(drag.id).then((ok) => {
      drag.granted = ok;
      if (!ok) {
        if (this.drag === drag) this.drag = undefined;
        this.orbit.enabled = true;
        return;
      }
      if (drag.ended) this.finish(drag);
    });
  };
  private move = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!d.granted) return;
    this.cast(e);
    const p = this.ray.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!p) return;
    p.add(d.offset);
    d.last.copy(p);
    d.samples.push({ t: performance.now(), p: p.clone() });
    d.samples = d.samples.slice(-12);
    this.actions.move(d.id, p);
  };
  private up = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopImmediatePropagation();
    d.ended = true;
    if (d.granted) this.finish(d);
  };
  private cancel = (e: PointerEvent) => {
    if (this.drag) this.drag.cancelled = true;
    this.up(e);
  };
  private finish(d: NonNullable<TouchInput["drag"]>) {
    this.actions.drop(
      d.id,
      d.cancelled ? new THREE.Vector3() : flickVelocity(d.samples),
    );
    if (this.drag === d) this.drag = undefined;
    this.orbit.enabled = true;
  }
  update(dt: number) {
    if (this.stick.lengthSq() === 0) return;
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(
      forward,
      new THREE.Vector3(0, 1, 0),
    );
    const delta = forward
      .multiplyScalar(-this.stick.y * dt * 1.5)
      .addScaledVector(right, this.stick.x * dt * 1.5);
    this.camera.position.add(delta);
    this.orbit.target.add(delta);
  }
}
