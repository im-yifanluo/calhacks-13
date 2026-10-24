import * as THREE from "three";
import type { DynamicObject, Keyframe } from "@memreplay/shared";
import { type LoadedMemory, type LoadedObject, proxyGeometry } from "./loader.js";
import { colliderDepth, Physics, STEP } from "./physics.js";
import { SAME_TIME, Timeline, type Branch } from "./timeline.js";
import { keyframe, keyframeVelocity, sampleTrack, trackVelocity, validateTrack } from "./tracks.js";

/** What a grab at the very end of the memory says. */
export const AT_END = "That's the end of the memory. Scrub back or press Play, then pause to grab something.";

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

/**
 * People "ghosts" (and anything else that is neither grabbable nor massive) only replay. They get no pick proxy and no
 * physics body: a ghost's collider would sit at its identity track's origin, an invisible obstacle in the room.
 */
export function isGhost(definition: DynamicObject): boolean {
  return definition.visual.kind === "points-sequence" || (!definition.grabbable && definition.mass === 0);
}

export class Viewer {
  readonly timeline: Timeline;
  readonly physics: Physics;
  readonly pickables: THREE.Mesh[] = [];
  readonly listeners = new Set<(event: ViewerEvent) => void>();
  held: LoadedObject | null = null;
  private authority?: InteractionAuthority;
  private activeSimulation: { object: LoadedObject; time: number; startTime: number; frames: Keyframe[]; branchId: string; steps: number } | null = null;
  /**
   * A throw preview that came to rest keeps showing its final pose, instead of snapping back to the release pose,
   * while the clock stays where it was paused (time and take). Play, seek, a take change or an applied clock end it.
   * A grab meanwhile catches the preview at its rest time, as grabbing a running preview does, so nothing jumps.
   */
  private restHold: { object: LoadedObject; frame: Keyframe; time: number; branchId: string } | null = null;
  /** Other players' throws that came to rest while we watched, held at their landing pose like our own restHold. */
  private remoteHolds = new Map<string, { frame: Keyframe; time: number; branchId: string }>();
  /** The status line still shows "Throw recorded…" from our last throw. */
  private throwNoted = false;
  private accumulator = 0;
  private motion = new THREE.Vector3();
  private angularMotion = new THREE.Vector3();
  private initialVelocity = new THREE.Vector3();
  private lastMove = 0;
  private operation = 0;
  private pendingGrab = false;
  private pendingRequest: GrabRequest | null = null;
  private lastPublish = 0;
  private disposed = false;
  private remotePoses = new Map<string, { from: Keyframe; to: Keyframe; receivedAt: number }>();
  private floorTarget = new THREE.Vector3();

  constructor(readonly memory: LoadedMemory, readonly report: (message: string) => void) {
    this.timeline = new Timeline(memory.manifest.timeline.durationSec);
    this.physics = new Physics(memory.manifest.world.floorY, memory.roomGeometry);
    for (const object of memory.objects) {
      if (isGhost(object.definition)) continue;
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

  setAuthority(authority: InteractionAuthority | undefined): void { this.authority = authority; }
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
    const timeline = this.timeline, time = timeline.time, hold = this.restHold;
    // Anything that moved the clock ends the hold, including paths that bypass finishSimulation.
    if (hold && (timeline.playing || timeline.activeId !== hold.branchId || Math.abs(time - hold.time) >= SAME_TIME)) this.restHold = null;
    for (const [id, remoteHold] of this.remoteHolds)
      if (timeline.playing || timeline.activeId !== remoteHold.branchId || Math.abs(time - remoteHold.time) >= SAME_TIME) this.remoteHolds.delete(id);
    for (const object of this.memory.objects) {
      const { definition, root } = object;
      const simulated = this.held === object || this.activeSimulation?.object === object;
      const track = timeline.track(definition.id, object.track);
      // An edited object stays in its take past the original visibleTo while a take's recording drives it
      // (timeline.track returns a recording only once t has reached its first frame).
      root.visible = track !== object.track || (time >= definition.visibleFrom && time <= definition.visibleTo);
      const remote = this.remotePoses.get(definition.id);
      if (simulated) { /* physics drives it */ }
      else if (remote) sampleTrack([remote.from, remote.to], (performance.now() - remote.receivedAt) / 1000, root);
      else if (this.restHold?.object === object) sampleTrack([this.restHold.frame], 0, root);
      else if (this.remoteHolds.has(definition.id)) sampleTrack([this.remoteHolds.get(definition.id)!.frame], 0, root);
      else sampleTrack(track, time, root);
      if (root.visible) object.updateVisual?.(time);
    }
  }

  /** The velocity physics starts an object with at the paused time: its active keyframe's v, else the track's finite difference. */
  private velocityAt(object: LoadedObject, out = new THREE.Vector3()): THREE.Vector3 {
    return keyframeVelocity(this.timeline.track(object.definition.id, object.track), this.timeline.time, out);
  }

  private seedColliders(): void {
    this.physics.clear();
    for (const object of this.memory.objects) if (object.root.visible && !isGhost(object.definition)) {
      this.physics.add(object, this.velocityAt(object));
    }
  }

  /** The lowest the object's origin may be, so its collider stays on or above the floor in this rotation. */
  private floorLimit(object: LoadedObject, rotation: THREE.Quaternion): number {
    return this.memory.manifest.world.floorY + colliderDepth(object.definition.collider, rotation, object.root.scale.x, object.hull);
  }

  async grab(objectId: string): Promise<boolean> {
    if (this.disposed || this.held || this.pendingGrab || this.timeline.playing) return false;
    // Nothing can be edited at the very end (a take made there has no time left to play), so say so.
    if (this.timeline.time >= this.timeline.duration) { this.report(AT_END); return false; }
    const object = this.memory.objects.find(o => o.definition.id === objectId);
    if (!object?.definition.grabbable || !object.root.visible) return false;
    this.throwNoted = false;
    // Grabbing while a throw preview runs, or while its final pose is held, catches it: the edit happens at the
    // preview's time, so what is on screen and the take agree. A preview that ran to the clip end cannot be caught
    // (nothing can be edited at the end), so the edit then happens at the paused time.
    let catchTime = this.activeSimulation?.time ?? this.restHold?.frame.t ?? this.remoteHoldTime(objectId);
    if (catchTime !== undefined && catchTime >= this.timeline.duration) catchTime = undefined;
    this.finishSimulation();
    if (catchTime !== undefined) this.timeline.seek(catchTime);
    if (this.timeline.time >= this.timeline.duration) { this.report(AT_END); return false; }
    this.sample();
    if (!object.root.visible) return false;
    const op = ++this.operation;
    const authority = this.authority;
    const request: GrabRequest = { objectId, branchId: this.timeline.activeId, time: this.timeline.time, pose: keyframe(this.timeline.time, object.root) };
    this.pendingGrab = true; this.pendingRequest = request;
    try {
      const grant = authority ? await authority.acquire(request) : true;
      if (!grant) { this.report("Another player owns that object."); return false; }
      if (op !== this.operation || this.disposed) { authority?.release(objectId); return false; }
      const remote = this.remotePoses.get(objectId);
      if (remote) trackVelocity([remote.from, remote.to], 0, this.initialVelocity);
      else this.velocityAt(object, this.initialVelocity);
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
    finally { this.pendingGrab = false; this.pendingRequest = null; }
  }

  /** Move the held object. It is kept above the floor by its collider's depth (rotation included), whatever the input. */
  moveHeld(target: THREE.Vector3, rotation: THREE.Quaternion, dt: number): void {
    if (!this.held) return;
    const position = this.floorTarget.copy(target);
    position.y = Math.max(position.y, this.floorLimit(this.held, rotation));
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
    // Never release inside or under the floor (an object can rest there in its track, or be released unmoved).
    const floor = this.floorLimit(object, object.root.quaternion);
    if (object.root.position.y < floor) this.physics.hold(object.definition.id, this.floorTarget.copy(object.root.position).setY(floor), object.root.quaternion);
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
      const capped = simulation.steps >= 6000;
      this.emit({ type: "recording", objectId: id, branchId: simulation.branchId, frames: simulation.frames.map(f => ({ ...f, p: [...f.p], q: [...f.q] })) });
      this.emit({ type: "rest", objectId: id, branchId: simulation.branchId, pose: frame, velocity: [0, 0, 0] });
      this.authority?.release(id);
      this.activeSimulation = null;
      this.physics.clear();
      this.restHold = { object: simulation.object, frame: simulation.frames.at(-1)!, time: this.timeline.time, branchId: simulation.branchId };
      // A preview finished early by play, seek or a take change gets a short message; the caller may say more.
      this.report(capped ? "Throw recorded, capped at 100 seconds; the final pose is held afterward. Press Play to replay this take."
        : publish ? "Throw recorded. Press Play to replay this take." : "Throw recorded.");
      this.throwNoted = true;
    }
  }

  /** Ends a hold, completes a running preview at once and drops a held object. User actions and applied clocks start here. */
  private finishSimulation(): void {
    this.release();
    while (this.activeSimulation) this.simulationStep(false);
    this.restHold = null; this.remoteHolds.clear();
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

  /**
   * Apply the shared clock (seconds, not microseconds). Never emits a clock event. Ignored, without touching a held
   * object or a running preview, when:
   * - it matches the local clock: time within 1 ms, same playing, speed and branch;
   * - a grab is pending and it is paused within 1 ms of the request's time: the server's echo of that grab (its
   *   reducer forks and moves the room to the new branch in the same transaction). The grant switches branch;
   * - the branch is unknown (reported). Import branch rows with timeline.upsertBranch first.
   * Anything else is a genuine change and wins over local interaction: it finishes a running preview, drops a held
   * object and cancels a pending grab.
   */
  applyClock(time: number, playing: boolean, speed = 1, branchId = this.timeline.activeId): void {
    if (!Number.isFinite(time) || !Number.isFinite(speed) || speed <= 0) return;
    const timeline = this.timeline, target = Math.max(0, Math.min(timeline.duration, time));
    if (Math.abs(target - timeline.time) < SAME_TIME && playing === timeline.playing && speed === timeline.speed &&
      branchId === timeline.activeId) return;
    if (this.pendingRequest && !playing && Math.abs(target - this.pendingRequest.time) < SAME_TIME) return;
    if (!timeline.branches.some(b => b.id === branchId)) { this.report(`Ignored a clock update for an unknown take (${branchId}).`); return; }
    this.finishSimulation(); this.remotePoses.clear();
    if (branchId !== this.timeline.activeId) {
      this.timeline.select(branchId);
      // Someone else moved the room to another take: replace our stale "Throw recorded. Press Play…".
      if (this.throwNoted) {
        this.throwNoted = false;
        this.report(branchId === "original" ? "The room is on the original recording." : `The room switched to ${this.timeline.active.name}.`);
      }
    }
    this.timeline.seek(time); this.timeline.playing = playing; this.timeline.speed = speed; this.sample();
  }

  /** Feed 10–15 Hz remote owner updates; the display interpolates over one 15 Hz interval. */
  applyRemotePose(objectId: string, pose: Keyframe): void {
    validateTrack([pose], objectId);
    const object = this.memory.objects.find(o => o.definition.id === objectId);
    if (!object || this.held === object || this.activeSimulation?.object === object) return;
    if (this.restHold?.object === object) this.restHold = null; // someone else moves it now
    this.remoteHolds.delete(objectId);
    this.remotePoses.set(objectId, { from: keyframe(0, object.root), to: { ...pose, t: 1 / 15 }, receivedAt: performance.now() });
  }
  clearRemotePose(objectId: string): void { this.remotePoses.delete(objectId); }

  /**
   * Another player's throw of objectId came to rest while we watched it live: show it at its landing pose (the last
   * frame of its recording) while the clock stays where it is, as the thrower's own viewer does. The hold ends on
   * play, seek, a take change, an applied clock or a new remote move. Grabbing during the hold catches at the landing
   * time, as for our own throws.
   */
  holdPose(objectId: string, frame: Keyframe): void {
    validateTrack([frame], objectId);
    const object = this.memory.objects.find(o => o.definition.id === objectId);
    if (!object || this.held === object || this.activeSimulation?.object === object || this.timeline.playing) return;
    this.remotePoses.delete(objectId);
    this.remoteHolds.set(objectId, { frame: { ...frame, p: [...frame.p], q: [...frame.q] }, time: this.timeline.time, branchId: this.timeline.activeId });
    this.sample();
  }

  /** The landing time a grab catches at while other players' throws are held: that object's, else the latest. */
  private remoteHoldTime(objectId: string): number | undefined {
    const own = this.remoteHolds.get(objectId);
    if (own) return own.frame.t;
    let latest: number | undefined;
    for (const hold of this.remoteHolds.values()) latest = Math.max(latest ?? -Infinity, hold.frame.t);
    return latest;
  }

  /**
   * The server cleared our hold or simulation of objectId (we left the room, or the connection dropped). Stop writing
   * it at once; the recorded prefix is emitted. Only a pending grab of that same object is cancelled; a pending grab of
   * another object carries on.
   */
  revokeOwnership(objectId: string): void {
    if (this.pendingRequest?.objectId === objectId) this.cancelPendingGrab();
    if (this.held?.definition.id === objectId) this.held = null;
    if (this.restHold?.object.definition.id === objectId) this.restHold = null;
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
