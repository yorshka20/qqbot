import { applyEasing } from '../easing';
import type { IdleClip, IdleClipQuatKeyframe } from '../layers/clips/types';
import type { EasingType } from '../types';

/** Output of sampleClip: scalar channel map plus quaternion bone map. */
export interface SampledClipFrame {
  /**
   * Scalar channel contributions keyed by channel name
   * (e.g. `vrm.head.y`, `head.yaw`). Same semantics as the old return type;
   * additively mixed with other contributions by the compiler.
   */
  scalar: Record<string, number>;
  /**
   * Quaternion bone contributions keyed by base bone channel
   * (e.g. `vrm.hips`). The compiler emits four scalar output channels
   * `vrm.<bone>.q[xyzw]` after slerp-with-identity intensity scaling.
   */
  quat: Record<string, { x: number; y: number; z: number; w: number }>;
}

/**
 * Sample an IdleClip at `tSec` (clamped to [0, clip.duration]).
 *
 * Scalar tracks use each track's easing (default `easeInOutCubic`).
 * Quat tracks binary-search adjacent keyframes and slerp between them.
 *
 * Returns a `SampledClipFrame` with separate `scalar` and `quat` maps.
 * v1 clips (no quat tracks) return an empty `quat` map.
 *
 * Additive accumulation across same-channel scalar tracks for IdleClip compat;
 * in practice tracks are unique per channel.
 *
 * **Root-channel contract**: tracks targeting `vrm.root.*` are ignored
 * unconditionally. Character translation/rotation is owned exclusively by
 * `WalkingLayer`; VRMA authoring tools commonly bake non-zero root offsets
 * into exported clips as authoring artifacts, and applying them would yank
 * the character around every time a gesture plays. If a future animation
 * legitimately needs to move the character, route it through the walking
 * facade rather than re-enabling clip-path root emission.
 */
export function sampleClip(
  clip: IdleClip,
  tSec: number,
  defaultEasing: EasingType = 'easeInOutCubic',
): SampledClipFrame {
  const clamped = Math.max(0, Math.min(clip.duration, tSec));
  const scalar: Record<string, number> = {};
  const quat: Record<string, { x: number; y: number; z: number; w: number }> = {};

  for (const track of clip.tracks) {
    const kfs = track.keyframes;
    if (kfs.length === 0) continue;
    if (track.channel.startsWith('vrm.root.') || track.channel === 'vrm.root') continue;

    if (track.kind === 'quat') {
      // Quat track: binary-search and slerp between adjacent keyframes.
      const quatKfs = kfs as IdleClipQuatKeyframe[];
      let q: { x: number; y: number; z: number; w: number };

      if (clamped <= quatKfs[0].time) {
        const k = quatKfs[0];
        q = { x: k.x, y: k.y, z: k.z, w: k.w };
      } else if (clamped >= quatKfs[quatKfs.length - 1].time) {
        const k = quatKfs[quatKfs.length - 1];
        q = { x: k.x, y: k.y, z: k.z, w: k.w };
      } else {
        // Binary search for bracketing keyframes
        let lo = 0;
        let hi = quatKfs.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (quatKfs[mid].time <= clamped) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const a = quatKfs[lo];
        const b = quatKfs[hi];
        const span = b.time - a.time;
        const alpha = span <= 0 ? 0 : (clamped - a.time) / span;
        q = slerpQuat(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, alpha);
      }

      quat[track.channel] = q;
    } else {
      // Scalar track (kind === 'scalar' or kind absent — v1 backward compat).
      const scalarKfs = kfs as Array<{ time: number; value: number }>;

      // Before first keyframe — hold the first value.
      if (clamped <= scalarKfs[0].time) {
        scalar[track.channel] = (scalar[track.channel] ?? 0) + scalarKfs[0].value;
        continue;
      }
      // After last keyframe — hold the last value.
      const last = scalarKfs[scalarKfs.length - 1];
      if (clamped >= last.time) {
        scalar[track.channel] = (scalar[track.channel] ?? 0) + last.value;
        continue;
      }
      // Binary-search for bracketing keyframes. VRMA clips at 30Hz produce
      // 300+ keyframes per track; linear scan multiplied by ~100 tracks was
      // the dominant per-tick CPU cost.
      let lo = 0;
      let hi = scalarKfs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (scalarKfs[mid].time <= clamped) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const a = scalarKfs[lo];
      const b = scalarKfs[hi];
      const span = b.time - a.time;
      const progress = span <= 0 ? 1 : (clamped - a.time) / span;
      const eased = applyEasing(progress, track.easing ?? defaultEasing);
      const value = a.value + (b.value - a.value) * eased;
      scalar[track.channel] = (scalar[track.channel] ?? 0) + value;
    }
  }

  return { scalar, quat };
}

/**
 * Spherical linear interpolation between two unit quaternions (a, b) at t∈[0,1].
 * Ensures shortest-path interpolation by flipping b if dot product is negative.
 */
function slerpQuat(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  t: number,
): { x: number; y: number; z: number; w: number } {
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  // Ensure shortest arc
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }

  if (dot > 0.9995) {
    // Nearly identical quaternions — linear interpolation and normalise
    const rx = ax + t * (bx - ax);
    const ry = ay + t * (by - ay);
    const rz = az + t * (bz - az);
    const rw = aw + t * (bw - aw);
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    return { x: rx / len, y: ry / len, z: rz / len, w: rw / len };
  }

  const theta0 = Math.acos(dot);
  const sinTheta0 = Math.sin(theta0);
  const sinA = Math.sin((1 - t) * theta0) / sinTheta0;
  const sinB = Math.sin(t * theta0) / sinTheta0;

  return {
    x: sinA * ax + sinB * bx,
    y: sinA * ay + sinB * by,
    z: sinA * az + sinB * bz,
    w: sinA * aw + sinB * bw,
  };
}
