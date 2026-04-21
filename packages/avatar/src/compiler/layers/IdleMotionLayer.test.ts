/**
 * IdleMotionLayer tests — focus on the loop-mode behavior and per-channel
 * exclusion introduced alongside the VRM restPose work. Gap-mode behavior
 * is exercised indirectly through the existing AnimationCompiler test suite
 * and is not re-asserted here.
 */
import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../state/types';
import type { IdleClip } from './clips';
import { IdleMotionLayer } from './IdleMotionLayer';

const IDLE_ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1.0 };
const BUSY_ACTIVITY: AvatarActivity = { pose: 'thinking', ambientGain: 0.0 };

// A 2-second clip with a single keyframe per track at t=0 for deterministic
// loop-wrap math: sampleClip holds the first-keyframe value for t < kfs[0].time
// and the last-keyframe value for t >= last.time, so every sample in [0, 2)
// returns the same contribution regardless of wrap.
function makeTestLoopClip(): IdleClip {
  return {
    id: 'test-loop',
    duration: 2.0,
    tracks: [
      { channel: 'vrm.spine.x', keyframes: [{ time: 0, value: 0.1 }] },
      { channel: 'vrm.leftUpperArm.z', keyframes: [{ time: 0, value: -1.2 }] },
    ],
  };
}

describe('IdleMotionLayer loop mode', () => {
  test('setLoopClip switches layer into continuous loop and emits clip values', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    const out = layer.sample(1000, IDLE_ACTIVITY);
    expect(out['vrm.spine.x']).toBeCloseTo(0.1, 6);
    expect(out['vrm.leftUpperArm.z']).toBeCloseTo(-1.2, 6);
  });

  test('loop wraps past clip.duration — no null / NaN, keeps emitting', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    layer.sample(1000, IDLE_ACTIVITY); // seed loopStartMs
    // Advance 3s > duration=2s; loop should wrap to 1s-in-cycle and still emit.
    const out = layer.sample(4000, IDLE_ACTIVITY);
    expect(out['vrm.spine.x']).toBeCloseTo(0.1, 6);
    expect(Number.isFinite(out['vrm.leftUpperArm.z'])).toBe(true);
  });

  test('leaving idle stops emission; re-entering restarts at t=0 of loop', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    layer.sample(1000, IDLE_ACTIVITY);
    const busy = layer.sample(1100, BUSY_ACTIVITY);
    expect(Object.keys(busy)).toHaveLength(0);

    // Re-enter idle much later — the layer should treat it as a fresh loop start.
    const resumed = layer.sample(10_000, IDLE_ACTIVITY);
    expect(resumed['vrm.spine.x']).toBeCloseTo(0.1, 6);
  });

  test('setLoopClip(null) returns the layer to gap-mode silence (no clip active)', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());
    layer.sample(1000, IDLE_ACTIVITY);

    layer.setLoopClip(null);
    // Gap mode with no active clip and un-elapsed nextClipAt timer emits nothing.
    const out = layer.sample(1100, IDLE_ACTIVITY);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe('IdleMotionLayer per-channel exclusion', () => {
  test('channels in activeChannels set are dropped from loop-mode output', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    const activeChannels = new Set(['vrm.leftUpperArm.z']);
    const out = layer.sample(1000, IDLE_ACTIVITY, activeChannels);

    expect(out['vrm.leftUpperArm.z']).toBeUndefined();
    // Non-conflicting channel still contributes normally.
    expect(out['vrm.spine.x']).toBeCloseTo(0.1, 6);
  });

  test('empty activeChannels set has no effect — all channels pass through', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    const out = layer.sample(1000, IDLE_ACTIVITY, new Set());
    expect(out['vrm.leftUpperArm.z']).toBeCloseTo(-1.2, 6);
    expect(out['vrm.spine.x']).toBeCloseTo(0.1, 6);
  });

  test('activeChannels covering every clip channel yields an empty map', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeTestLoopClip());

    const all = new Set(['vrm.spine.x', 'vrm.leftUpperArm.z']);
    const out = layer.sample(1000, IDLE_ACTIVITY, all);
    expect(Object.keys(out)).toHaveLength(0);
  });
});
