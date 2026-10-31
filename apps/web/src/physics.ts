import RAPIER from "@dimforge/rapier3d-compat";
import { Object3D, Quaternion, Vector3 } from "three";
import type { DynamicObject, Keyframe } from "@memreplay/shared";
import type { GeometryData, LoadedObject } from "./loader.js";
import { keyframe } from "./tracks.js";

export const STEP = 1 / 60;
export interface BodyEntry {
  body: RAPIER.RigidBody;
  object: LoadedObject;
  scale: number;
}

export function collider(
  definition: DynamicObject["collider"],
  scale: number,
  hull?: Float32Array,
): RAPIER.ColliderDesc {
  switch (definition.kind) {
    case "sphere":
      return RAPIER.ColliderDesc.ball(definition.radius * scale);
    case "box":
      return RAPIER.ColliderDesc.cuboid(...(definition.halfExtents.map((x) => x * scale) as [number, number, number]));
    case "capsule":
      return RAPIER.ColliderDesc.capsule(definition.halfHeight * scale, definition.radius * scale);
    case "cylinder":
      return RAPIER.ColliderDesc.cylinder(definition.halfHeight * scale, definition.radius * scale);
    case "convex": {
      const shape = hull && RAPIER.ColliderDesc.convexHull(hull.map((x) => x * scale));
      if (!shape) throw new Error("Convex collider has no valid hull points");
      return shape;
    }
  }
}

const axis = new Vector3();
/** World-space y of the given local axis once rotated. */
const axisY = (x: number, y: number, z: number, rotation: Quaternion) => axis.set(x, y, z).applyQuaternion(rotation).y;

/**
 * How far the collider reaches below the body's origin when rotated by `rotation` and scaled by `scale`: its
 * vertical half-height for the centred shapes, the lowest hull point for a convex hull. A held object is kept at
 * least this far above the floor, so it is never released inside or under it.
 */
export function colliderDepth(
  definition: DynamicObject["collider"],
  rotation: Quaternion,
  scale: number,
  hull?: Float32Array,
): number {
  switch (definition.kind) {
    case "sphere":
      return definition.radius * scale;
    case "box": {
      const [x, y, z] = definition.halfExtents;
      return (
        scale *
        (Math.abs(axisY(1, 0, 0, rotation)) * x +
          Math.abs(axisY(0, 1, 0, rotation)) * y +
          Math.abs(axisY(0, 0, 1, rotation)) * z)
      );
    }
    case "capsule":
    case "cylinder": {
      // Both stand on the local Y axis. A cylinder's rim sticks out by radius·sin(tilt); a capsule's cap by its radius.
      const up = Math.min(1, Math.abs(axisY(0, 1, 0, rotation)));
      const rim = definition.kind === "capsule" ? 1 : Math.sqrt(1 - up * up);
      return scale * (definition.halfHeight * up + definition.radius * rim);
    }
    case "convex": {
      let lowest = Infinity;
      for (let i = 0; hull && i + 2 < hull.length; i += 3)
        lowest = Math.min(lowest, axisY(hull[i], hull[i + 1], hull[i + 2], rotation));
      return Number.isFinite(lowest) ? -lowest * scale : 0;
    }
  }
}

let ready: Promise<void> | undefined;
export async function initPhysics(): Promise<void> {
  await (ready ??= RAPIER.init());
}

export class Physics {
  readonly world: RAPIER.World;
  readonly bodies = new Map<string, BodyEntry>();
  private scratch = new Object3D();

  constructor(floorY: number, room: GeometryData[]) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(100, 0.1, 100)
        .setTranslation(0, floorY - 0.1, 0)
        .setFriction(0.8),
    );
    for (const geometry of room)
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(geometry.vertices, geometry.indices));
  }

  add(object: LoadedObject, velocity: Vector3, dynamic = false): BodyEntry {
    this.remove(object.definition.id);
    const { root, definition } = object;
    const desc = dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    desc
      .setTranslation(root.position.x, root.position.y, root.position.z)
      .setRotation(root.quaternion)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setCcdEnabled(true)
      .setLinearDamping(0.12)
      .setAngularDamping(0.15);
    const body = this.world.createRigidBody(desc);
    try {
      this.world.createCollider(
        collider(definition.collider, root.scale.x, object.hull)
          .setMass(Math.max(0.001, definition.mass))
          .setRestitution(0.35)
          .setFriction(0.65),
        body,
      );
    } catch (error) {
      this.world.removeRigidBody(body);
      throw error;
    }
    const entry = { body, object, scale: root.scale.x };
    this.bodies.set(definition.id, entry);
    return entry;
  }

  hold(id: string, position: Vector3, rotation: Quaternion): void {
    const entry = this.bodies.get(id)!;
    entry.body.setTranslation(position, true);
    entry.body.setRotation(rotation, true);
    entry.body.setNextKinematicTranslation(position);
    entry.body.setNextKinematicRotation(rotation);
    entry.object.root.position.copy(position);
    entry.object.root.quaternion.copy(rotation);
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
      object.root.position.copy(body.translation());
      object.root.quaternion.copy(body.rotation());
    }
  }

  frame(id: string, time: number): Keyframe {
    const entry = this.bodies.get(id)!;
    this.scratch.position.copy(entry.body.translation());
    this.scratch.quaternion.copy(entry.body.rotation());
    this.scratch.scale.setScalar(entry.scale);
    return keyframe(time, this.scratch);
  }

  remove(id: string): void {
    const entry = this.bodies.get(id);
    if (entry) {
      this.world.removeRigidBody(entry.body);
      this.bodies.delete(id);
    }
  }
  clear(): void {
    for (const id of this.bodies.keys()) this.remove(id);
  }
  dispose(): void {
    this.clear();
    this.world.free();
  }
}
