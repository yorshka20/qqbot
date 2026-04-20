import type { IdleClipKeyframe } from './validateSchema.js';

export interface ExpressionKeyframeData {
  times: Float32Array | number[];
  values: Float32Array | number[];
}

export interface ExpressionTrack {
  channel: string;
  keyframes: IdleClipKeyframe[];
}

/**
 * Sample scalar expression tracks at 30Hz.
 * Each expression name maps to a track named `vrm.expression.<name>`.
 */
export function sampleExpressions(
  expressionMap: Map<string, ExpressionKeyframeData>,
  duration: number,
  dt = 1 / 30,
): ExpressionTrack[] {
  const tracks: ExpressionTrack[] = [];
  const count = Math.floor(duration / dt) + 1;

  for (const [name, data] of expressionMap) {
    const keyframes: IdleClipKeyframe[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(i * dt, duration);
      const value = interpolateScalar(data, t);
      keyframes.push({ time: t, value });
    }
    tracks.push({
      channel: `vrm.expression.${name}`,
      keyframes,
    });
  }

  return tracks;
}

function interpolateScalar(
  track: ExpressionKeyframeData,
  t: number,
): number {
  const times = track.times;
  const values = track.values;
  const n = times.length;

  if (n === 0) return 0;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];

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
  return values[lo] + (values[hi] - values[lo]) * alpha;
}
