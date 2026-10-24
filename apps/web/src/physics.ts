import RAPIER from "@dimforge/rapier3d-compat";
import { Object3D, Quaternion, Vector3 } from "three";
import type { DynamicObject, Keyframe } from "@memreplay/shared";
import type { GeometryData, LoadedObject } from "./loader.js";
import { keyframe } from "./tracks.js";

export const STEP = 1 / 60;
export interface BodyEntry { body: RAPIER.RigidBody; object: LoadedObject; scale: number }

export function collider(definition: DynamicObject["collider"], scale: number, hull?: Float32Array): RAPIER.ColliderDesc {
  switch (definition.kind) {
    case "sphere": return RAPIER.ColliderDesc.ball(definition.radius * scale);
    case "box": return RAPIER.ColliderDesc.cuboid(...definition.halfExtents.map(x => x * scale) as [number, number, number]);
    case "capsule": return RAPIER.ColliderDesc.capsule(definition.halfHeight * scale, definition.radius * scale);
    case "convex": {
      const shape = hull && RAPIER.ColliderDesc.convexHull(hull.map(x => x * scale));
      if (!shape) throw new Error("Convex collider has no valid hull points");
      return shape;
    }
  }
}

let ready: Promise<void> | undefined;
export async function initPhysics(): Promise<void> { await (ready ??= RAPIER.init()); }

export class Physics {
  readonly world: RAPIER.World;
  readonly bodies = new Map<string, BodyEntry>();
  private scratch = new Object3D();

  constructor(floorY: number, room: GeometryData[]) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.1, 100).setTranslation(0, floorY - 0.1, 0).setFriction(0.8));
    for (const geometry of room) this.world.createCollider(RAPIER.ColliderDesc.trimesh(geometry.vertices, geometry.indices));
  }

  add(object: LoadedObject, velocity: Vector3, dynamic = false): BodyEntry {
    this.remove(object.definition.id);
    const { root, definition } = object;
    const desc = dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(root.position.x, root.position.y, root.position.z).setRotation(root.quaternion)
      .setLinvel(velocity.x, velocity.y, velocity.z).setCcdEnabled(true).setLinearDamping(0.12).setAngularDamping(0.15);
    const body = this.world.createRigidBody(desc);
    try {
      this.world.createCollider(collider(definition.collider, root.scale.x, object.hull)
        .setMass(Math.max(0.001, definition.mass)).setRestitution(0.35).setFriction(0.65), body);
    } catch (error) { this.world.removeRigidBody(body); throw error; }
    const entry = { body, object, scale: root.scale.x };
    this.bodies.set(definition.id, entry);
    return entry;
  }

  hold(id: string, position: Vector3, rotation: Quaternion): void {
    const entry = this.bodies.get(id)!;
    entry.body.setTranslation(position, true); entry.body.setRotation(rotation, true);
    entry.body.setNextKinematicTranslation(position); entry.body.setNextKinematicRotation(rotation);
    entry.object.root.position.copy(position); entry.object.root.quaternion.copy(rotation);
  }

  release(id: string, velocity: Vector3, angularVelocity = new Vector3()): void {
    const body = this.bodies.get(id)!.body;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setLinvel(velocity.clone().clampLength(0, 12), true);
    body.setAngvel(angularVelocity.clone().clampLength(0, 20), true);
  }

  step(): void {
    this.world.step();
    for (const { body, object } of this.bodies.values()) {
      object.root.position.copy(body.translation()); object.root.quaternion.copy(body.rotation());
    }
  }

  frame(id: string, time: number): Keyframe {
    const entry = this.bodies.get(id)!;
    this.scratch.position.copy(entry.body.translation()); this.scratch.quaternion.copy(entry.body.rotation());
    this.scratch.scale.setScalar(entry.scale);
    return keyframe(time, this.scratch);
  }

  remove(id: string): void {
    const entry = this.bodies.get(id);
    if (entry) { this.world.removeRigidBody(entry.body); this.bodies.delete(id); }
  }
  clear(): void { for (const id of this.bodies.keys()) this.remove(id); }
  dispose(): void { this.clear(); this.world.free(); }
}
