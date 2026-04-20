import * as THREE from 'three';
import type { QuaternionKeyframeData } from './sampleTrack.js';
import type { IdleClipKeyframe } from './validateSchema.js';

export interface TranslationKeyframeData {
  times: Float32Array | number[];
  /** Interleaved [x, y, z, x, y, z, ...] */
  values: Float32Array | number[];
}

export interface RootMotionTracks {
  rootX: IdleClipKeyframe[];
  rootZ: IdleClipKeyframe[];
  rootRotY: IdleClipKeyframe[];
}

/**
 * Extract hips translation → vrm.root.x, vrm.root.z (Y ignored).
 * Extract hips rotation → vrm.root.rotY (Y euler from YXZ decomposition).
 *
 * If max|dx| < 0.01 && max|dz| < 0.01 && max|dRotY| < 0.01, emits zero root tracks.
 */
export function extractRootMotion(
  translationTrack: TranslationKeyframeData | null,
  rotationTrack: QuaternionKeyframeData | null,
  duration: number,
  dt = 1 / 30,
): RootMotionTracks | null {
  const count = Math.floor(duration / dt) + 1;

  const rootX: IdleClipKeyframe[] = [];
  const rootZ: IdleClipKeyframe[] = [];
  const rootRotY: IdleClipKeyframe[] = [];

  for (let i = 0; i < count; i++) {
    const t = Math.min(i * dt, duration);

    // Translation X/Z
    let tx = 0;
    let tz = 0;
    if (translationTrack) {
      const v = interpolateTranslation(translationTrack, t);
      tx = v.x;
      tz = v.z;
    }
    rootX.push({ time: t, value: tx });
    rootZ.push({ time: t, value: tz });

    // Rotation Y
    let rotY = 0;
    if (rotationTrack) {
      const q = interpolateQuaternion(rotationTrack, t);
      const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      rotY = euler.y;
    }
    rootRotY.push({ time: t, value: rotY });
  }

  // Check thresholds
  const maxAbsDelta = (arr: IdleClipKeyframe[]) => {
    const base = arr[0]?.value ?? 0;
    let max = 0;
    for (const kf of arr) {
      const d = Math.abs(kf.value - base);
      if (d > max) max = d;
    }
    return max;
  };

  const dX = maxAbsDelta(rootX);
  const dZ = maxAbsDelta(rootZ);
  const dRotY = maxAbsDelta(rootRotY);

  if (dX < 0.01 && dZ < 0.01 && dRotY < 0.01) {
    return null;
  }

  return { rootX, rootZ, rootRotY };
}

function interpolateTranslation(
  track: TranslationKeyframeData,
  t: number,
): THREE.Vector3 {
  const times = track.times;
  const values = track.values;
  const n = times.length;

  if (n === 0) return new THREE.Vector3();
  if (t <= times[0]) {
    return new THREE.Vector3(values[0], values[1], values[2]);
  }
  if (t >= times[n - 1]) {
    const base = (n - 1) * 3;
    return new THREE.Vector3(values[base], values[base + 1], values[base + 2]);
  }

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

  const lo3 = lo * 3;
  const hi3 = hi * 3;
  return new THREE.Vector3(
    values[lo3] + (values[hi3] - values[lo3]) * alpha,
    values[lo3 + 1] + (values[hi3 + 1] - values[lo3 + 1]) * alpha,
    values[lo3 + 2] + (values[hi3 + 2] - values[lo3 + 2]) * alpha,
  );
}

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
