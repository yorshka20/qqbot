import type { EasingType } from '../../types';

/**
 * Keyframe-based idle animation clip. Simpler than Cubism's `.motion3.json`
 * (no bezier, no per-curve fade, no effects) but expressive enough to capture
 * the "naturalistic multi-channel drift" pattern of hand-authored idle motions.
 *
 * A clip is a list of per-channel tracks. Each track is a list of
 * `{ time, value }` keyframes in seconds from the start of the clip. The
 * clip's `duration` is the time at which it ends; tracks shorter than the
 * clip duration hold their final value.
 *
 * Playback: at any time `t` within the clip, the track's contribution is the
 * interpolation (using the configured easing) between the two keyframes
 * bracketing `t`. Values are additively mixed with other layers' outputs by
 * the compiler.
 */
export interface IdleClip {
  /** Stable identifier; used for logging / debug. */
  id: string;
  /** Full clip duration in seconds. */
  duration: number;
  /** Per-channel keyframe tracks. */
  tracks: IdleClipTrack[];
}

export interface IdleClipTrack {
  /** Semantic channel id (e.g. "head.yaw"). */
  channel: string;
  /** Easing between adjacent keyframes. Defaults to `easeInOutCubic`. */
  easing?: EasingType;
  /** Keyframes in ascending `time` order. Must have at least one. */
  keyframes: { time: number; value: number }[];
}
