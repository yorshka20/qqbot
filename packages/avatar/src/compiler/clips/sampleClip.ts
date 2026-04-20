import { applyEasing } from '../easing';
import type { IdleClip } from '../layers/clips/types';
import type { EasingType } from '../types';

/**
 * Sample an IdleClip at `tSec` (clamped to [0, clip.duration]) using each
 * track's easing (default `easeInOutCubic`). Returns a sparse channel→value
 * map.
 *
 * Additive accumulation across same-channel tracks for IdleClip compat;
 * in practice tracks are unique per channel.
 *
 * Extracted from IdleMotionLayer.sampleClip so the AnimationCompiler can
 * reuse the same sampler for `kind:"clip"` action execution.
 */
export function sampleClip(
  clip: IdleClip,
  tSec: number,
  defaultEasing: EasingType = 'easeInOutCubic',
): Record<string, number> {
  const clamped = Math.max(0, Math.min(clip.duration, tSec));
  const out: Record<string, number> = {};
  for (const track of clip.tracks) {
    const kfs = track.keyframes;
    if (kfs.length === 0) continue;

    // Before first keyframe — hold the first value.
    if (clamped <= kfs[0].time) {
      out[track.channel] = (out[track.channel] ?? 0) + kfs[0].value;
      continue;
    }
    // After last keyframe — hold the last value.
    const last = kfs[kfs.length - 1];
    if (clamped >= last.time) {
      out[track.channel] = (out[track.channel] ?? 0) + last.value;
      continue;
    }
    // Interpolate between the bracketing keyframes.
    let i = 0;
    while (i < kfs.length - 1 && kfs[i + 1].time < clamped) i++;
    const a = kfs[i];
    const b = kfs[i + 1];
    const span = b.time - a.time;
    const progress = span <= 0 ? 1 : (clamped - a.time) / span;
    const eased = applyEasing(progress, track.easing ?? defaultEasing);
    const value = a.value + (b.value - a.value) * eased;
    out[track.channel] = (out[track.channel] ?? 0) + value;
  }
  return out;
}
