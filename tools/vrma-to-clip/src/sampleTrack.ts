import * as THREE from 'three';
import type { IdleClipKeyframe, IdleClipQuatKeyframe } from './validateSchema.js';

export interface Keyframe {
  time: number;
  value: number;
}

export interface EulerTracks {
  xTrack: Keyframe[];
  yTrack: Keyframe[];
  zTrack: Keyframe[];
}

/**
 * Input quaternion keyframe track as parallel arrays.
 */
export interface QuaternionKeyframeData {
  times: Float32Array | number[];
  /** Interleaved [x, y, z, w, x, y, z, w, ...] */
  values: Float32Array | number[];
}

/**
 * Sample a quaternion keyframe track at 30Hz and decompose into 3 Euler XYZ tracks.
 * Used for bones whose max rotation angle is ≤ π/2 (small-angle path).
 */
export function sampleBoneEulerXYZ(
  quaternionTrack: QuaternionKeyframeData,
  duration: number,
  dt = 1 / 30,
): EulerTracks {
  const xTrack: Keyframe[] = [];
  const yTrack: Keyframe[] = [];
  const zTrack: Keyframe[] = [];

  const count = Math.floor(duration / dt) + 1;

  for (let i = 0; i < count; i++) {
    const t = Math.min(i * dt, duration);
    const q = interpolateQuaternion(quaternionTrack, t);
    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    xTrack.push({ time: t, value: euler.x });
    yTrack.push({ time: t, value: euler.y });
    zTrack.push({ time: t, value: euler.z });
  }

  return { xTrack, yTrack, zTrack };
}

/**
 * Sample a quaternion keyframe track at 30Hz, returning raw unit quaternion
 * frames. Used for bones whose max rotation angle is > π/2 (large-angle path)
 * where Euler XYZ decomposition would fold or flip.
 *
 * Returns `Math.floor(duration / dt) + 1` frames.
 */
export function sampleBoneQuaternion(
  quaternionTrack: QuaternionKeyframeData,
  duration: number,
  dt = 1 / 30,
): IdleClipQuatKeyframe[] {
  const count = Math.floor(duration / dt) + 1;
  const frames: IdleClipQuatKeyframe[] = [];

  for (let i = 0; i < count; i++) {
    const t = Math.min(i * dt, duration);
    const q = interpolateQuaternion(quaternionTrack, t);
    frames.push({ time: t, x: q.x, y: q.y, z: q.z, w: q.w });
  }

  return frames;
}

/**
 * Compute the maximum rotation angle (in radians) across a set of sampled
 * quaternion frames. Uses `2 * acos(|w|)` per frame as the rotation angle.
 *
 * Returns 0 for identity-only sequences and approximately π for a 0→π sweep.
 */
export function maxRotationAngle(quatFrames: IdleClipQuatKeyframe[]): number {
  let maxAngle = 0;
  for (const frame of quatFrames) {
    const angle = 2 * Math.acos(Math.min(1, Math.abs(frame.w)));
    if (angle > maxAngle) {
      maxAngle = angle;
    }
  }
  return maxAngle;
}

/**
 * Linearly interpolate (slerp) between quaternion keyframes.
 */
function interpolateQuaternion(
  track: QuaternionKeyframeData,
  t: number,
): THREE.Quaternion {
  const times = track.times;
  const values = track.values;
  const n = times.length;

  if (n === 0) return new THREE.Quaternion();
  if (t <= times[0]) {
    return new THREE.Quaternion(values[0], values[1], values[2], values[3]);
  }
  if (t >= times[n - 1]) {
    const base = (n - 1) * 4;
    return new THREE.Quaternion(values[base], values[base + 1], values[base + 2], values[base + 3]);
  }

  // Binary search for bracketing keyframes
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const alpha = t1 === t0 ? 0 : (t - t0) / (t1 - t0);

  const lo4 = lo * 4;
  const hi4 = hi * 4;
  const q0 = new THREE.Quaternion(values[lo4], values[lo4 + 1], values[lo4 + 2], values[lo4 + 3]);
  const q1 = new THREE.Quaternion(values[hi4], values[hi4 + 1], values[hi4 + 2], values[hi4 + 3]);

  return q0.slerp(q1, alpha);
}

/**
 * Returns true if the track has meaningful motion (max - min >= 1e-5 radians).
 * Returns false for static/near-static tracks that can be dropped.
 */
export function filterStatic(track: IdleClipKeyframe[]): boolean {
  if (track.length === 0) return false;
  let min = track[0].value;
  let max = track[0].value;
  for (const kf of track) {
    if (kf.value < min) min = kf.value;
    if (kf.value > max) max = kf.value;
  }
  return max - min >= 1e-5;
}
