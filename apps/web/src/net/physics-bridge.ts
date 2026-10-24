// P3 integration adapter: local owner simulates; every other client interpolates server state.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Keyframe, DynamicObject } from "@memreplay/shared";
import type { Multiplayer, Pose } from "./index";
export type Interactable = { mesh: THREE.Object3D; definition: DynamicObject };
export class PhysicsBridge {
  private world: RAPIER.World;
  private moving = new Map<
    string,
    {
      body: RAPIER.RigidBody;
      item: Interactable;
      start: number;
      elapsed: number;
      lastSent: number;
      frames: Keyframe[];
      pending: Promise<void>;
      finishing: boolean;
    }
  >();
  private held?: Interactable;
  private lastMove = 0;
  private disposed = false;
  static async create(net: Multiplayer, floorY: number) {
    await RAPIER.init();
    return new PhysicsBridge(net, floorY);
  }
  private constructor(
    private net: Multiplayer,
    floorY: number,
  ) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(100, 0.1, 100).setTranslation(
        0,
        floorY - 0.1,
        0,
      ),
    );
  }
  pose(mesh: THREE.Object3D, v = new THREE.Vector3()): Pose {
    const p = mesh.position,
      q = mesh.quaternion;
    return {
      px: p.x,
      py: p.y,
      pz: p.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: v.x,
      vy: v.y,
      vz: v.z,
    };
  }
  async grab(item: Interactable) {
    if (
      this.disposed ||
      !this.net.ready ||
      !this.net.timeline?.paused ||
      this.held ||
      this.moving.has(item.definition.id)
    )
      return false;
    const ok = await this.net.grab(item.definition.id, this.pose(item.mesh));
    if (ok && !this.disposed) this.held = item;
    return ok && !this.disposed;
  }
  move(id: string, p: THREE.Vector3) {
    if (this.held?.definition.id !== id) return;
    this.held.mesh.position.copy(p);
    if (performance.now() - this.lastMove > 67) {
      this.lastMove = performance.now();
      void this.net.move(id, this.pose(this.held.mesh));
    }
  }
  async drop(id: string, v: THREE.Vector3) {
    const item = this.held;
    if (item?.definition.id !== id) return;
    this.held = undefined;
    if (
      !(await this.net.release(id, false, this.pose(item.mesh, v))) ||
      this.disposed
    )
      return;
    const p = item.mesh.position,
      q = item.mesh.quaternion;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation(q)
        .setLinvel(v.x, v.y, v.z)
        .setLinearDamping(0.5)
        .setAngularDamping(0.5),
    );
    const c = item.definition.collider;
    // Box/sphere/capsule are supported here; P3 can supply convex/environment colliders via its physics layer.
    let collider =
      c.kind === "sphere"
        ? RAPIER.ColliderDesc.ball(c.radius)
        : c.kind === "capsule"
          ? RAPIER.ColliderDesc.capsule(c.halfHeight, c.radius)
          : c.kind === "box"
            ? RAPIER.ColliderDesc.cuboid(...c.halfExtents)
            : RAPIER.ColliderDesc.cuboid(0.15, 0.15, 0.15);
    this.world.createCollider(
      collider
        .setMass(Math.max(0.01, item.definition.mass))
        .setRestitution(0.25)
        .setFriction(0.8),
      body,
    );
    const start = this.net.time();
    this.moving.set(id, {
      body,
      item,
      start,
      elapsed: 0,
      lastSent: -1,
      frames: [{ t: start, p: p.toArray(), q: q.toArray() }],
      pending: Promise.resolve(),
      finishing: false,
    });
  }
  private record(
    id: string,
    entry: ReturnType<PhysicsBridge["entry"]>,
    flush = false,
  ) {
    if (!flush && entry.frames.length < 25) return;
    if (entry.frames.length === 0) return;
    const frames = entry.frames;
    entry.frames = [];
    const branchId = this.net.timeline?.branchId;
    if (!branchId) return;
    entry.pending = entry.pending.then(async () => {
      if (this.disposed) return;
      const ok = await this.net.run(() =>
        this.net.connection!.reducers.saveBranchKeyframes({
          branchId,
          objectId: id,
          startMediaUs: BigInt(Math.round(frames[0].t * 1e6)),
          keyframesJson: JSON.stringify(frames),
        }),
      );
      if (!ok) throw new Error("Could not save branch trajectory");
    });
    // Mark rejected writes as handled immediately; finalization still observes the rejection.
    void entry.pending.catch(() => {});
  }
  private entry(id: string) {
    return this.moving.get(id)!;
  }
  update(dt: number) {
    if (this.disposed) return;
    if (
      this.held &&
      (!this.net.ready ||
        !this.net.objects
          .find((o) => o.objectId === this.held!.definition.id)
          ?.simOwner?.isEqual(this.net.identity!))
    )
      this.held = undefined;
    this.world.timestep = Math.min(dt, 1 / 30);
    this.world.step();
    for (const [id, e] of this.moving) {
      const state = this.net.objects.find((o) => o.objectId === id);
      if (!this.net.ready || !state?.simOwner?.isEqual(this.net.identity!)) {
        this.world.removeRigidBody(e.body);
        this.moving.delete(id);
        continue;
      }
      if (e.finishing) continue;
      e.elapsed += Math.min(dt, 1 / 30);
      const p = e.body.translation(),
        q = e.body.rotation(),
        v = e.body.linvel();
      e.item.mesh.position.set(p.x, p.y, p.z);
      e.item.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      const t = Math.min(
        Number(this.net.memory!.durationUs) / 1e6,
        e.start + e.elapsed,
      );
      if (e.elapsed - e.lastSent >= 1 / 15) {
        e.lastSent = e.elapsed;
        void this.net.move(
          id,
          this.pose(e.item.mesh, new THREE.Vector3(v.x, v.y, v.z)),
        );
        if (t > (e.frames.at(-1)?.t ?? -1))
          e.frames.push({ t, p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] });
        this.record(id, e);
      }
      if (
        e.body.isSleeping() ||
        e.elapsed > 10 ||
        t >= Number(this.net.memory!.durationUs) / 1e6
      ) {
        e.finishing = true;
        this.record(id, e, true);
        void e.pending
          .catch((error) => this.net.report(error))
          .then(async () => {
            if (this.disposed || this.moving.get(id) !== e) return;
            await this.net.release(id, true, this.pose(e.item.mesh));
            if (this.disposed || this.moving.get(id) !== e) return;
            this.world.removeRigidBody(e.body);
            this.moving.delete(id);
          });
      }
    }
  }
  owns(id: string) {
    return this.held?.definition.id === id || this.moving.has(id);
  }
  dispose() {
    this.disposed = true;
    this.held = undefined;
    this.moving.clear();
    this.world.free();
  }
}
