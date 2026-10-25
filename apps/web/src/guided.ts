import * as THREE from "three";
import type { Keyframe } from "@memreplay/shared";

/**
 * Guided exploration. A memory reconstructed from one hand-held camera is only reliable near where that camera
 * went, looking where it looked. This draws the recorded path on the floor and, in guided mode,
 *  - keeps the viewer's head inside a corridor around the path (thumbstick/orbit moves are clamped; a body that
 *    walks out in VR fades to black),
 *  - fogs the view as the gaze turns away from every direction the camera looked from nearby spots.
 * Free mode shows the path only.
 */
export class PathGuide {
  readonly root = new THREE.Group();
  guided = false;
  /** half-width of the corridor, m */
  radius = 0.75;
  private readonly points: THREE.Vector3[] = [];
  private readonly forwards: THREE.Vector3[] = [];
  private readonly ribbon: THREE.Mesh;
  private readonly fog: THREE.Mesh;
  private readonly fogMaterial: THREE.MeshBasicMaterial;
  private readonly halfFovH: number;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private fade = 0;

  constructor(track: Keyframe[], floorY: number, fovYDeg: number, aspect: number, camera: THREE.Camera) {
    const q = new THREE.Quaternion();
    for (const k of track) {
      this.points.push(new THREE.Vector3(k.p[0], k.p[1], k.p[2]));
      q.set(k.q[0], k.q[1], k.q[2], k.q[3]).normalize();
      this.forwards.push(new THREE.Vector3(0, 0, -1).applyQuaternion(q));
    }
    this.halfFovH = Math.atan(Math.tan(THREE.MathUtils.degToRad(fovYDeg) / 2) * aspect);
    // the path, drawn just above the floor
    const floor = this.points.map(p => new THREE.Vector3(p.x, floorY + 0.02, p.z));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(floor),
      new THREE.LineBasicMaterial({ color: 0xededf0, transparent: true, opacity: 0.9, depthTest: false }));
    line.renderOrder = 50;
    this.root.add(line);
    const start = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xededf0 }));
    start.position.copy(floor[0]);
    this.root.add(start);
    this.ribbon = new THREE.Mesh(ribbonGeometry(floor, this.radius),
      new THREE.MeshBasicMaterial({ color: 0xededf0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    this.ribbon.renderOrder = 49;
    this.root.add(this.ribbon);
    // fog quad in front of the eyes (works in XR too: it is a child of the camera)
    this.fogMaterial = new THREE.MeshBasicMaterial({ color: 0x0a0a0f, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.fog = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fogMaterial);
    this.fog.position.set(0, 0, -0.11);
    this.fog.renderOrder = 1000;
    this.fog.frustumCulled = false;
    this.fog.visible = false;
    camera.add(this.fog);
    this.setGuided(false);
  }

  setGuided(on: boolean): void {
    this.guided = on;
    this.ribbon.visible = on;
    if (!on) { this.fade = 0; this.fogMaterial.opacity = 0; this.fog.visible = false; }
  }

  /** Nearest point on the path (xz) to `p`; returns the horizontal distance. */
  private nearest(p: THREE.Vector3, out: THREE.Vector3): number {
    let best = Infinity;
    for (let i = 0; i + 1 < this.points.length; i++) {
      const a = this.points[i], b = this.points[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-9 ? THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1) : 0;
      const x = a.x + t * abx, z = a.z + t * abz;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) { best = d; out.set(x, p.y, z); }
    }
    return best;
  }

  /** Keep a world position inside the corridor. Returns the correction applied (zero if none). */
  clamp(worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (!this.guided || this.points.length < 2) return out;
    const d = this.nearest(worldPos, this.tmp);
    if (d <= this.radius) return out;
    // pull back to the corridor edge
    const k = this.radius / d;
    out.set(this.tmp.x + (worldPos.x - this.tmp.x) * k - worldPos.x, 0, this.tmp.z + (worldPos.z - this.tmp.z) * k - worldPos.z);
    return out;
  }

  /** Fade fully out (e.g. while the recording's tracking was lost), whatever the mode. */
  blackout(on: boolean, dt: number): void {
    if (!on) { if (!this.guided) { this.fade += (0 - this.fade) * Math.min(1, dt * 6); this.fogMaterial.opacity = this.fade; this.fog.visible = this.fade > 0.01; } return; }
    this.fade += (0.97 - this.fade) * Math.min(1, dt * 6);
    this.fogMaterial.opacity = this.fade;
    this.fog.visible = true;
  }

  /** How far outside the corridor a head is, m (0 inside). */
  excess(worldPos: THREE.Vector3): number {
    if (this.points.length < 2) return 0;
    return Math.max(0, this.nearest(worldPos, this.tmp) - this.radius);
  }

  /**
   * Fog from the gaze: the smallest angle between the current look direction and the directions the camera looked
   * from spots within 1.5 m. Starts fading 12° outside the recorded field of view, fully fogged 50° further out.
   * `outside` (m beyond the corridor) adds its own fade. Call once per frame with the head's world transform.
   */
  update(headPos: THREE.Vector3, headQuat: THREE.Quaternion, outside: number, dt: number): void {
    if (!this.guided) return;
    this.fwd.set(0, 0, -1).applyQuaternion(headQuat);
    let minAngle = Math.PI;
    let near = 0;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (Math.hypot(p.x - headPos.x, p.z - headPos.z) > 1.5) continue;
      near++;
      const a = this.fwd.angleTo(this.forwards[i]);
      if (a < minAngle) minAngle = a;
    }
    if (near === 0) minAngle = Math.PI;      // nothing recorded near here
    const start = this.halfFovH + THREE.MathUtils.degToRad(12), end = start + THREE.MathUtils.degToRad(50);
    const gaze = THREE.MathUtils.smoothstep(minAngle, start, end);
    const body = THREE.MathUtils.clamp(outside / 0.4, 0, 1);
    const target = Math.max(gaze * 0.92, body * 0.95);
    this.fade += (target - this.fade) * Math.min(1, dt * 6);
    this.fogMaterial.opacity = this.fade;
    this.fog.visible = this.fade > 0.01;
  }
}

/** A flat strip of width 2r along a polyline, for the corridor. */
function ribbonGeometry(points: THREE.Vector3[], r: number): THREE.BufferGeometry {
  const verts: number[] = [], idx: number[] = [];
  const side = new THREE.Vector3(), dir = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    dir.subVectors(b, a); dir.y = 0;
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
    dir.normalize();
    side.set(-dir.z, 0, dir.x).multiplyScalar(r);
    const p = points[i];
    verts.push(p.x + side.x, p.y + 0.01, p.z + side.z, p.x - side.x, p.y + 0.01, p.z - side.z);
    if (i > 0) {
      const k = 2 * i;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  return g;
}
