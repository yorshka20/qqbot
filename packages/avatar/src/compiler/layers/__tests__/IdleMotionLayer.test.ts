/**
 * IdleMotionLayer tests — focus on loop-mode behavior (including the
 * freeze-on-gate-exit + resume-from-frozen-frame semantics) and per-channel
 * exclusion. Gap-mode behavior is exercised indirectly through the existing
 * AnimationCompiler test suite and is not re-asserted here.
 */
import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import type { IdleClip } from '../clips';
import { IdleMotionLayer } from '../IdleMotionLayer';

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

// A 2-second clip whose single track interpolates linearly from 0 → 1 over
// the full duration. `sampleClip` default easing is `easeInOutCubic`, so the
// emitted value is a non-linear but monotonically increasing function of
// elapsed time — good enough to distinguish "frozen at t=0.5" from "fresh at
// t=0" without pinning exact easing output.
function makeRampLoopClip(): IdleClip {
  return {
    id: 'test-ramp',
    duration: 2.0,
    tracks: [
      {
        channel: 'vrm.leftUpperArm.z',
        keyframes: [
          { time: 0, value: 0 },
          { time: 2, value: 1 },
        ],
      },
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

  test('leaving idle freezes the loop at the current frame (emission continues)', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeRampLoopClip());

    // Seed loopStartMs at t=1000, then advance to t=2000 while idle so the
    // clip has progressed to elapsedSec=1.0.
    layer.sample(1000, IDLE_ACTIVITY);
    const midIdle = layer.sample(2000, IDLE_ACTIVITY);
    const frozenValue = midIdle['vrm.leftUpperArm.z'];
    expect(frozenValue).toBeGreaterThan(0);
    expect(frozenValue).toBeLessThan(1);

    // Gate closes — layer must keep emitting, and the value must match the
    // frame captured when the gate closed, regardless of real-time drift.
    const busy1 = layer.sample(2100, BUSY_ACTIVITY);
    expect(busy1['vrm.leftUpperArm.z']).toBeCloseTo(frozenValue, 6);

    const busy2 = layer.sample(5000, BUSY_ACTIVITY);
    expect(busy2['vrm.leftUpperArm.z']).toBeCloseTo(frozenValue, 6);
  });

  test('re-entering idle resumes from the frozen frame, not from t=0', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeRampLoopClip());

    // Progress to elapsedSec=1.0, then gate off for a long real-time interval.
    layer.sample(1000, IDLE_ACTIVITY);
    const midIdle = layer.sample(2000, IDLE_ACTIVITY);
    const frozenValue = midIdle['vrm.leftUpperArm.z'];
    layer.sample(2100, BUSY_ACTIVITY);

    // Re-enter idle 10 s later. The first post-resume tick emits the frozen
    // frame exactly (no jump at the boundary) — i.e. NOT 0 (which is what a
    // t=0 restart would produce for this ramp clip).
    const firstResume = layer.sample(12_100, IDLE_ACTIVITY);
    expect(firstResume['vrm.leftUpperArm.z']).toBeCloseTo(frozenValue, 6);

    // Subsequent ticks advance forward from the resumed frame.
    const laterResume = layer.sample(12_500, IDLE_ACTIVITY);
    expect(laterResume['vrm.leftUpperArm.z']).toBeGreaterThan(frozenValue);
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

describe('IdleMotionLayer quat output', () => {
  function makeQuatLoopClip(): IdleClip {
    // Single-keyframe quat + scalar in one clip so we can assert both maps
    // are populated and that quat flows through sampleQuat(), not sample().
    return {
      id: 'test-quat',
      duration: 2.0,
      tracks: [
        { channel: 'vrm.spine.x', keyframes: [{ time: 0, value: 0.1 }] },
        {
          kind: 'quat',
          channel: 'vrm.rightLowerArm',
          keyframes: [{ time: 0, x: 0.3, y: 0, z: 0, w: 0.9539392 }],
        },
      ],
    };
  }

  test('loop clip quat tracks surface via sampleQuat(), not sample()', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeQuatLoopClip());

    const scalar = layer.sample(1000, IDLE_ACTIVITY);
    const quat = layer.sampleQuat(1000, IDLE_ACTIVITY);

    // Scalar track flows through sample(); quat track does NOT appear there.
    expect(scalar['vrm.spine.x']).toBeCloseTo(0.1, 6);
    expect(scalar['vrm.rightLowerArm']).toBeUndefined();

    // Quat bone surfaces through sampleQuat() at full amplitude.
    const q = quat['vrm.rightLowerArm'];
    expect(q).toBeDefined();
    expect(q.x).toBeCloseTo(0.3, 6);
    expect(q.w).toBeCloseTo(0.9539392, 6);
  });

  test('sampleQuat() without a preceding sample() returns empty (cache miss)', () => {
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeQuatLoopClip());

    const quat = layer.sampleQuat(1000, IDLE_ACTIVITY);
    expect(Object.keys(quat)).toHaveLength(0);
  });

  test('activeChannels does NOT filter quat bones (they flow through as slerp anchor)', () => {
    // Quat output is intentionally unfiltered: AnimationCompiler reads the
    // idle quat for an animated bone as the slerp anchor so the clip's
    // release tail blends back to the idle pose rather than identity.
    // Scalar still gets filtered (tested below under "per-channel exclusion").
    const layer = new IdleMotionLayer();
    layer.setLoopClip(makeQuatLoopClip());

    const active = new Set(['vrm.rightLowerArm']);
    layer.sample(1000, IDLE_ACTIVITY, active);
    const quat = layer.sampleQuat(1000, IDLE_ACTIVITY, active);
    const q = quat['vrm.rightLowerArm'];
    expect(q).toBeDefined();
    expect(q.x).toBeCloseTo(0.3, 6);
    expect(q.w).toBeCloseTo(0.9539392, 6);
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
