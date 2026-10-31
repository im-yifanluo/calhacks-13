import { MathUtils, type Object3D, Vector3 } from "three";
import type { Keyframe } from "@memreplay/shared";
import { segment } from "./tracks.js";

/**
 * Follow mode (the default for a recorded memory): while the memory plays you walk the wearer's recorded path, and
 * choose where to look yourself (drag on a screen, the headset in VR). Pausing frees you to roam anywhere; Play glides
 * you back onto the path at the current time, then you follow it again. Position only: the look direction, field
 * of view and exposure stay the viewer's own (wearer's view, in main.ts, replays all of the recorded camera).
 */

/** Seconds a resume (or a jump in time while playing) takes to glide back onto the path. */
export const GLIDE_SECONDS = 0.6;
/** A playing clock that moved this much more (or less) than the frame's dt was a seek or a re-anchor, not playback. */
export const JUMP_SECONDS = 0.25;

const next = new Vector3(),
  head = new Vector3();

/** Where the recorded camera was at time t: linear between keyframes, endpoints held (as tracks.sampleTrack does). */
export function pathPosition(track: Keyframe[], t: number, out = new Vector3()): Vector3 {
  if (!track.length) return out;
  const [a, b] = segment(track, t);
  const k = b.t > a.t ? MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  return out.fromArray(a.p).lerp(next.fromArray(b.p), k);
}

/** The position lock. Call step() once per frame, after the timeline ticked. */
export class PathFollower {
  private engaged = false;
  private lastTime = 0;
  private glideFrom: Vector3 | null = null;
  private glideElapsed = 0;

  constructor(
    readonly track: Keyframe[],
    readonly glideSeconds = GLIDE_SECONDS,
  ) {}

  /** A glide back onto the path is under way. */
  get gliding(): boolean {
    return this.glideFrom !== null;
  }

  /**
   * One frame. `lock`: follow mode is on and the memory plays. `current`: where the eyes are now (world). Returns
   * `out` set to where the eyes go this frame, or null while unlocked (paused: roam anywhere; nothing is moved).
   * Engaging the lock, or the clock jumping while locked, starts a glide from `current` to the path, which tracks the
   * moving path position and lands on it after glideSeconds (eased in and out).
   */
  step(lock: boolean, time: number, current: Vector3, dt: number, out: Vector3, speed = 1): Vector3 | null {
    if (!lock) {
      this.engaged = false;
      this.glideFrom = null;
      return null;
    }
    const jumped = this.engaged && Math.abs(time - this.lastTime - Math.max(0, dt) * speed) > JUMP_SECONDS;
    pathPosition(this.track, time, out);
    if (!this.engaged || jumped) {
      // Already on the path (within a millimetre): nothing to glide.
      this.glideFrom = current.distanceTo(out) > 1e-3 ? (this.glideFrom ?? new Vector3()).copy(current) : null;
      this.glideElapsed = 0;
    } else if (this.glideFrom) this.glideElapsed += Math.max(0, dt);
    this.engaged = true;
    this.lastTime = time;
    if (this.glideFrom) {
      const k = this.glideElapsed / this.glideSeconds;
      if (k >= 1) this.glideFrom = null;
      else out.lerpVectors(this.glideFrom, out, MathUtils.smoothstep(k, 0, 1));
    }
    return out;
  }
}

/**
 * VR: move the rig so that the headset ends up at `target` (rig origin = target minus the headset's offset in the
 * rig). `head` is the user camera under the rig; its world position is rig × the last head pose WebXR wrote.
 */
export function placeHead(rig: Object3D, camera: Object3D, target: Vector3): void {
  camera.getWorldPosition(head);
  rig.position.add(next.subVectors(target, head));
  rig.updateMatrixWorld(true);
}
