import { Object3D, Quaternion, Vector3 } from "three";
import type { Keyframe } from "@memreplay/shared";

const p = new Vector3();
const q = new Quaternion();

export function validateTrack(value: unknown, label = "track"): asserts value is Keyframe[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}: expected nonempty keyframes`);
  let previous = -Infinity;
  for (const frame of value) {
    if (
      !frame ||
      !Number.isFinite(frame.t) ||
      frame.t < 0 ||
      frame.t <= previous ||
      !tuple(frame.p, 3) ||
      !tuple(frame.q, 4) ||
      Math.hypot(...frame.q) < 1e-8 ||
      (frame.s !== undefined && (!Number.isFinite(frame.s) || frame.s <= 0))
    ) {
      throw new Error(`${label}: invalid pose or timestamps (must strictly increase)`);
    }
    // Optional velocity in m/s. Absent means "derive it from the track". Anything else malformed (null, two numbers,
    // NaN) is rejected, because it would reach Rapier's setLinvel. The pipeline omits unset fields (exclude_none).
    if (frame.v !== undefined && !tuple(frame.v, 3)) {
      throw new Error(`${label}: keyframe at t=${frame.t} has an invalid v (expected three finite numbers)`);
    }
    previous = frame.t;
  }
}

export function tuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

export function segment(track: Keyframe[], t: number): [Keyframe, Keyframe] {
  let low = 0,
    high = track.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (track[mid].t <= t) low = mid;
    else high = mid;
  }
  return [track[low], track[high]];
}

export function sampleTrack(track: Keyframe[], t: number, out: Object3D): void {
  if (!track.length) return;
  const [a, b] = segment(track, t);
  const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  out.position.fromArray(a.p).lerp(p.fromArray(b.p), k);
  out.quaternion.fromArray(a.q).normalize().slerp(q.fromArray(b.q).normalize(), k);
  out.scale.setScalar((a.s ?? 1) + ((b.s ?? 1) - (a.s ?? 1)) * k);
}

/** Finite-difference velocity of the segment containing t; zero outside [first, last). */
export function trackVelocity(track: Keyframe[], t: number, out = new Vector3()): Vector3 {
  if (track.length < 2 || t < track[0].t || t >= track.at(-1)!.t) return out.set(0, 0, 0);
  const [a, b] = segment(track, t);
  return out
    .fromArray(b.p)
    .sub(p.fromArray(a.p))
    .divideScalar(b.t - a.t);
}

/**
 * The velocity physics starts from when time is paused at t. Uses the recorded `v` of the active keyframe (the last
 * one at or before t), interpolated towards the next keyframe's `v` when that one has a `v` too. Falls back to
 * trackVelocity when the active keyframe has no `v`. Zero outside [first, last), like trackVelocity: the replay holds
 * the end poses there, so nothing is moving. Tracks are validated on load, so a present `v` is three finite numbers.
 */
export function keyframeVelocity(track: Keyframe[], t: number, out = new Vector3()): Vector3 {
  if (track.length < 2 || t < track[0].t || t >= track.at(-1)!.t) return out.set(0, 0, 0);
  const [a, b] = segment(track, t);
  if (!a.v) return trackVelocity(track, t, out);
  out.fromArray(a.v);
  if (b.v && b.t > a.t) out.lerp(p.fromArray(b.v), Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))));
  return out;
}

export function keyframe(t: number, object: Object3D): Keyframe {
  return { t, p: object.position.toArray(), q: object.quaternion.toArray(), s: object.scale.x };
}
