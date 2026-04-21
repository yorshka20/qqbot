import type { EasingType } from '../../types';

/**
 * Keyframe-based idle animation clip. Simpler than Cubism's `.motion3.json`
 * (no bezier, no per-curve fade, no effects) but expressive enough to capture
 * the "naturalistic multi-channel drift" pattern of hand-authored idle motions.
 *
 * A clip is a list of per-channel tracks. Each track is either a scalar track
 * (v1, `kind` absent or `'scalar'`) or a quaternion track (v2, `kind: 'quat'`).
 *
 * Scalar tracks: `{ time, value }` keyframes in seconds from clip start.
 * The clip's `duration` is the time at which it ends; tracks shorter than the
 * clip duration hold their final value.
 *
 * Quat tracks: `{ time, x, y, z, w }` keyframes; channel is the base bone
 * channel without axis suffix (e.g. `vrm.hips`). The compiler slерps between
 * adjacent keyframes and emits four scalar output channels `vrm.<bone>.q[xyzw]`
 * after intensity / envelope / fade scaling (slerp-with-identity approximation).
 * Quat output channels bypass spring-damper smoothing and channel-baseline
 * addition, and disappear from `currentParams` on the first tick they are not
 * contributed.
 *
 * Playback: at any time `t` within the clip, scalar track contribution is
 * interpolated (using the configured easing) between bracketing keyframes.
 * Values are additively mixed with other layers' outputs by the compiler.
 *
 * Quat and Euler scalar tracks must not coexist for the same bone. If both
 * appear, the renderer must prefer quat.
 */
export interface IdleClip {
  /** Stable identifier; used for logging / debug. */
  id: string;
  /** Full clip duration in seconds. */
  duration: number;
  /** Per-channel keyframe tracks. */
  tracks: IdleClipTrack[];
}

/** Scalar keyframe (v1 and v2 scalar tracks). */
export interface IdleClipScalarKeyframe {
  time: number;
  value: number;
}

/** Quaternion keyframe (v2 quat tracks). */
export interface IdleClipQuatKeyframe {
  time: number;
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Scalar track (v1 compatible).
 * Channel is e.g. `vrm.head.y`, `head.yaw`.
 * `kind` defaults to `'scalar'` when absent.
 */
export interface IdleClipScalarTrack {
  kind?: 'scalar';
  /** Semantic channel id (e.g. "vrm.head.y", "head.yaw"). */
  channel: string;
  /** Easing between adjacent keyframes. Defaults to `easeInOutCubic`. */
  easing?: EasingType;
  /** Keyframes in ascending `time` order. Must have at least one. */
  keyframes: IdleClipScalarKeyframe[];
}

/**
 * Quaternion track (v2). Channel is the base bone channel without axis suffix
 * (e.g. `vrm.hips`). The compiler emits four scalar output channels
 * `vrm.<bone>.q[xyzw]`. Only produced by the converter when
 * `maxRotationAngle > π/2`.
 */
export interface IdleClipQuatTrack {
  kind: 'quat';
  /** Base bone channel, e.g. `vrm.hips`. No axis suffix. */
  channel: string;
  /** Quaternion keyframes in ascending `time` order. Must have at least one. */
  keyframes: IdleClipQuatKeyframe[];
}

/** Discriminated union of scalar and quaternion tracks. */
export type IdleClipTrack = IdleClipScalarTrack | IdleClipQuatTrack;
