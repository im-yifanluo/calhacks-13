import * as THREE from "three";
import type { Keyframe } from "@memreplay/shared";
import { type LoadedMemory, type LoadedObject, proxyGeometry } from "./loader.js";
import { Physics, STEP } from "./physics.js";
import { Timeline, type Branch } from "./timeline.js";
import { keyframe, sampleTrack, trackVelocity, validateTrack } from "./tracks.js";

export interface GrabRequest { objectId: string; branchId: string; time: number; pose: Keyframe }
/** P4 installs this gate before enabling shared-room interaction. Never grant optimistically. */
export interface InteractionAuthority {
  acquire(request: GrabRequest): Promise<boolean | { branch: Omit<Branch, "tracks"> }>;
  release(objectId: string): void;
}
export type ViewerEvent =
  | { type: "clock"; time: number; playing: boolean; branchId: string }
  | { type: "fork"; id: string; parentId: string; time: number; name: string }
  | { type: "grab" | "throw" | "rest"; objectId: string; branchId: string; pose: Keyframe; velocity: [number, number, number] }
  | { type: "pose"; objectId: string; branchId: string; pose: Keyframe; velocity: [number, number, number] }
  | { type: "recording"; objectId: string; branchId: string; frames: Keyframe[] };

export class Viewer {
  readonly timeline: Timeline;
  readonly physics: Physics;
  readonly pickables: THREE.Mesh[] = [];
  readonly listeners = new Set<(event: ViewerEvent) => void>();
  held: LoadedObject | null = null;
  private authority?: InteractionAuthority;
  private activeSimulation: { object: LoadedObject; time: number; startTime: number; frames: Keyframe[]; branchId: string; steps: number } | null = null;
  private accumulator = 0;
  private motion = new THREE.Vector3();
  private angularMotion = new THREE.Vector3();
  private initialVelocity = new THREE.Vector3();
  private lastMove = 0;
  private operation = 0;
  private pendingGrab = false;
  private lastPublish = 0;
  private disposed = false;
  private remotePoses = new Map<string, { from: Keyframe; to: Keyframe; receivedAt: number }>();

  constructor(readonly memory: LoadedMemory, readonly report: (message: string) => void) {
    this.timeline = new Timeline(memory.manifest.timeline.durationSec);
    this.physics = new Physics(memory.manifest.world.floorY, memory.roomGeometry);
    for (const object of memory.objects) {
      const geometry = proxyGeometry(object.definition.collider);
      if (object.hull) {
        geometry.dispose();
        const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(object.hull, 3));
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z),
          new THREE.MeshBasicMaterial({ visible: false }));
        proxy.userData.objectId = object.definition.id; object.root.add(proxy); this.pickables.push(proxy);
      } else {
        const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
        proxy.userData.objectId = object.definition.id; object.root.add(proxy); this.pickables.push(proxy);
      }
    }
    this.sample();
  }

  setAuthority(authority: InteractionAuthority): void { this.authority = authority; }
  subscribe(listener: (event: ViewerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: ViewerEvent): void { for (const listener of this.listeners) { try { listener(event); } catch (error) { console.error("Viewer listener", error); } } }
  private clockEvent(): void { this.emit({ type: "clock", time: this.timeline.time, playing: this.timeline.playing, branchId: this.timeline.activeId }); }

  pick(raycaster: THREE.Raycaster): THREE.Intersection | undefined {
    this.memory.root.updateMatrixWorld(true);
    return raycaster.intersectObjects(this.pickables, false).find(hit => {
      const object = this.memory.objects.find(o => o.definition.id === hit.object.userData.objectId)!;
      return object.root.visible && object.definition.grabbable;
    });
  }

  private sample(): void {
    for (const object of this.memory.objects) {
      const { definition, root } = object;
      const simulated = this.held === object || this.activeSimulation?.object === object;
      root.visible = this.timeline.time >= definition.visibleFrom && this.timeline.time <= definition.visibleTo;
      const remote = this.remotePoses.get(definition.id);
      if (!simulated && remote) sampleTrack([remote.from, remote.to], (performance.now() - remote.receivedAt) / 1000, root);
      else if (!simulated) sampleTrack(this.timeline.track(definition.id, object.track), this.timeline.time, root);
      if (root.visible) object.updateVisual?.(this.timeline.time);
    }
  }

  private seedColliders(): void {
    this.physics.clear();
    for (const object of this.memory.objects) if (object.root.visible) {
      this.physics.add(object, trackVelocity(this.timeline.track(object.definition.id, object.track), this.timeline.time));
    }
  }

  async grab(objectId: string): Promise<boolean> {
    if (this.disposed || this.held || this.pendingGrab || this.timeline.playing || this.timeline.time >= this.timeline.duration) return false;
    const object = this.memory.objects.find(o => o.definition.id === objectId);
    if (!object?.definition.grabbable || !object.root.visible) return false;
    const catchTime = this.activeSimulation?.time;
    this.finishSimulation();
    if (catchTime !== undefined) this.timeline.seek(catchTime);
    if (this.timeline.time >= this.timeline.duration) return false;
    this.sample();
    const op = ++this.operation;
    const authority = this.authority;
    const request: GrabRequest = { objectId, branchId: this.timeline.activeId, time: this.timeline.time, pose: keyframe(this.timeline.time, object.root) };
    this.pendingGrab = true;
    try {
      const grant = authority ? await authority.acquire(request) : true;
      if (!grant) { this.report("Another player owns that object."); return false; }
      if (op !== this.operation || this.disposed) { authority?.release(objectId); return false; }
      const remote = this.remotePoses.get(objectId);
      this.initialVelocity.copy(remote ? trackVelocity([remote.from, remote.to], 0) :
        trackVelocity(this.timeline.track(objectId, object.track), this.timeline.time));
      this.remotePoses.delete(objectId);
      try { this.seedColliders(); } catch (error) { authority?.release(objectId); throw error; }
      let branch: Branch;
      if (typeof grant === "object") {
        try {
          this.timeline.upsertBranch(grant.branch); this.timeline.activeId = grant.branch.id;
          branch = this.timeline.active;
        } catch (error) { this.physics.clear(); authority?.release(objectId); throw error; }
      } else {
        branch = this.timeline.fork();
        this.emit({ type: "fork", id: branch.id, parentId: branch.parentId!, time: branch.forkTime, name: branch.name });
      }
      this.held = object;
      this.motion.set(0, 0, 0); this.angularMotion.set(0, 0, 0); this.lastMove = performance.now();
      this.emit({ type: "grab", objectId, branchId: branch.id, pose: keyframe(this.timeline.time, object.root), velocity: this.initialVelocity.toArray() });
      this.report(`Holding ${object.definition.label}. Move and release to throw.`);
      return true;
    } catch (error) { this.report(`Grab failed: ${String(error)}`); return false; }
    finally { this.pendingGrab = false; }
  }

  moveHeld(position: THREE.Vector3, rotation: THREE.Quaternion, dt: number): void {
    if (!this.held) return;
    const elapsed = Math.max(1 / 240, Math.min(dt, 0.1));
    const instantaneous = position.clone().sub(this.held.root.position).divideScalar(elapsed).clampLength(0, 12);
    this.motion.lerp(instantaneous, 0.45);
    const delta = rotation.clone().multiply(this.held.root.quaternion.clone().invert()).normalize();
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const axis = new THREE.Vector3(delta.x, delta.y, delta.z);
    const angle = 2 * Math.atan2(axis.length(), delta.w);
    this.angularMotion.lerp(axis.normalize().multiplyScalar(angle / elapsed).clampLength(0, 20), 0.45);
    this.physics.hold(this.held.definition.id, position, rotation);
    this.lastMove = performance.now();
    if (this.lastMove - this.lastPublish > 1000 / 15) {
      this.lastPublish = this.lastMove;
      this.emit({ type: "pose", objectId: this.held.definition.id, branchId: this.timeline.activeId,
        pose: keyframe(this.timeline.time, this.held.root), velocity: this.motion.toArray() });
    }
  }

  cancelPendingGrab(): void { ++this.operation; }

  release(): void {
    this.cancelPendingGrab();
    const object = this.held;
    if (!object) return;
    this.held = null;
    // A stationary hand retains the recorded momentum. A stale pointer sample is not a throw.
    if (performance.now() - this.lastMove > 100) { this.motion.set(0, 0, 0); this.angularMotion.set(0, 0, 0); }
    const velocity = this.motion.clone().add(this.initialVelocity).clampLength(0, 12);
    this.physics.release(object.definition.id, velocity, this.angularMotion);
    const frame = this.physics.frame(object.definition.id, this.timeline.time);
    const frames = [...(this.timeline.active.tracks.get(object.definition.id) ?? []).filter(f => f.t < this.timeline.time), frame];
    this.timeline.active.tracks.set(object.definition.id, frames);
    this.activeSimulation = { object, time: this.timeline.time, startTime: this.timeline.time, branchId: this.timeline.activeId, frames, steps: 0 };
    this.accumulator = 0;
    this.emit({ type: "throw", objectId: object.definition.id, branchId: this.timeline.activeId, pose: frame, velocity: velocity.toArray() });
    this.report("Recording this throw. Play the take to replay it, or switch to Original.");
  }

  private simulationStep(publish = true): void {
    const simulation = this.activeSimulation;
    if (!simulation) return;
    this.physics.step(); simulation.steps++;
    simulation.time = Math.min(this.timeline.duration, simulation.startTime + simulation.steps * STEP);
    const id = simulation.object.definition.id;
    const frame = this.physics.frame(id, simulation.time);
    if (frame.t > simulation.frames.at(-1)!.t) simulation.frames.push(frame);
    const body = this.physics.bodies.get(id)!.body;
    if (publish && simulation.steps % 4 === 0) this.emit({ type: "pose", objectId: id, branchId: simulation.branchId, pose: frame,
      velocity: [body.linvel().x, body.linvel().y, body.linvel().z] });
    if (body.isSleeping() || simulation.time >= this.timeline.duration || simulation.steps >= 6000) {
      if (simulation.steps >= 6000) this.report("Recording capped at 100 seconds; the final pose is held afterward.");
      this.emit({ type: "recording", objectId: id, branchId: simulation.branchId, frames: simulation.frames.map(f => ({ ...f, p: [...f.p], q: [...f.q] })) });
      this.emit({ type: "rest", objectId: id, branchId: simulation.branchId, pose: frame, velocity: [0, 0, 0] });
      this.authority?.release(id);
      this.activeSimulation = null;
      this.physics.clear();
    }
  }

  private finishSimulation(): void {
    this.release();
    while (this.activeSimulation) this.simulationStep(false);
  }

  togglePlay(): void {
    this.finishSimulation();
    if (this.timeline.time >= this.timeline.duration) this.timeline.seek(0);
    this.timeline.playing = !this.timeline.playing;
    this.sample(); this.clockEvent();
  }
  seek(time: number): void {
    this.finishSimulation(); this.remotePoses.clear(); this.timeline.playing = false; this.timeline.seek(time); this.sample(); this.clockEvent();
  }
  selectBranch(id: string): void {
    this.finishSimulation(); this.remotePoses.clear(); this.timeline.select(id); this.sample(); this.clockEvent();
    this.report(id === "original" ? "Original recording. Pause anywhere to make a new take." : "Alternate take selected. Press Play to replay your edit.");
  }

  /** Incoming shared-clock updates do not echo a clock event. Times are seconds, not microseconds. */
  applyClock(time: number, playing: boolean, speed = 1, branchId = this.timeline.activeId): void {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.finishSimulation(); this.remotePoses.clear();
    if (branchId !== this.timeline.activeId) this.timeline.select(branchId);
    this.timeline.seek(time); this.timeline.playing = playing; this.timeline.speed = speed; this.sample();
  }

  /** Feed 10–15 Hz remote owner updates; the display interpolates over one 15 Hz interval. */
  applyRemotePose(objectId: string, pose: Keyframe): void {
    validateTrack([pose], objectId);
    const object = this.memory.objects.find(o => o.definition.id === objectId);
    if (!object || this.held === object || this.activeSimulation?.object === object) return;
    this.remotePoses.set(objectId, { from: keyframe(0, object.root), to: { ...pose, t: 1 / 15 }, receivedAt: performance.now() });
  }
  clearRemotePose(objectId: string): void { this.remotePoses.delete(objectId); }

  /** P4 calls this when a thrown object is caught by another player. Stop writing immediately. */
  revokeOwnership(objectId: string): void {
    this.cancelPendingGrab();
    if (this.held?.definition.id === objectId) this.held = null;
    if (this.activeSimulation?.object.definition.id === objectId) {
      const simulation = this.activeSimulation;
      this.emit({ type: "recording", objectId, branchId: simulation.branchId,
        frames: simulation.frames.map(f => ({ ...f, p: [...f.p], q: [...f.q] })) });
      this.activeSimulation = null;
    }
    this.physics.remove(objectId);
  }

  update(dt: number): void {
    this.timeline.tick(dt);
    if (this.activeSimulation) {
      this.accumulator += Math.min(dt, 0.1);
      while (this.accumulator >= STEP && this.activeSimulation) { this.simulationStep(); this.accumulator -= STEP; }
    }
    this.sample();
  }

  get recording(): boolean { return this.activeSimulation !== null; }
  get busy(): boolean { return this.held !== null || this.pendingGrab; }
  dispose(): void {
    this.disposed = true; this.finishSimulation(); this.listeners.clear(); this.physics.dispose(); this.memory.dispose();
  }
}
