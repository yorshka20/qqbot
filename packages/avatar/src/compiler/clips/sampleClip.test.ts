import { describe, expect, it } from 'bun:test';
import type { IdleClip } from '../layers/clips/types';
import { sampleClip } from './sampleClip';

const clip: IdleClip = {
  id: 'test',
  duration: 2,
  tracks: [
    {
      channel: 'head.yaw',
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 10 },
        { time: 2, value: 0 },
      ],
    },
    {
      channel: 'body.x',
      keyframes: [
        { time: 0.5, value: 1 },
        { time: 1.5, value: -1 },
      ],
    },
  ],
};

describe('sampleClip', () => {
  it('at t=0: head.yaw=0, body.x=1 (held before first kf)', () => {
    const result = sampleClip(clip, 0);
    expect(result.scalar['head.yaw']).toBe(0);
    expect(result.scalar['body.x']).toBe(1);
  });

  it('at t=1: head.yaw=10 (on kf), body.x≈0 (midpoint interpolation)', () => {
    const result = sampleClip(clip, 1);
    expect(result.scalar['head.yaw']).toBe(10);
    // body.x: t=1 is midpoint of [0.5,1.5], easeInOutCubic(0.5)=0.5, value=1+(−1−1)*0.5=0
    expect(Math.abs(result.scalar['body.x'])).toBeLessThan(1e-9);
  });

  it('at t=2: head.yaw=0, body.x=-1 (end of clip)', () => {
    const result = sampleClip(clip, 2);
    expect(result.scalar['head.yaw']).toBe(0);
    expect(result.scalar['body.x']).toBe(-1);
  });

  it('clamps t=-1 to t=0', () => {
    const at0 = sampleClip(clip, 0);
    const atNeg = sampleClip(clip, -1);
    expect(atNeg).toEqual(at0);
  });

  it('clamps t=99 to t=2 (clip end)', () => {
    const at2 = sampleClip(clip, 2);
    const at99 = sampleClip(clip, 99);
    expect(at99).toEqual(at2);
  });

  it('empty-tracks clip returns {scalar:{}, quat:{}}', () => {
    const empty: IdleClip = { id: 'e', duration: 1, tracks: [] };
    const result = sampleClip(empty, 0.5);
    expect(result.scalar).toEqual({});
    expect(result.quat).toEqual({});
  });

  it('v1 clip (no quat tracks) returns empty quat map', () => {
    const result = sampleClip(clip, 1);
    expect(result.quat).toEqual({});
  });

  it('quat track is sampled correctly at midpoint (slerp)', () => {
    // 90-degree Y rotation: identity at t=0, (0, sin45, 0, cos45) at t=2
    const sin45 = Math.sin(Math.PI / 4);
    const cos45 = Math.cos(Math.PI / 4);
    const quatClip: IdleClip = {
      id: 'qtest',
      duration: 2,
      tracks: [
        {
          kind: 'quat',
          channel: 'vrm.hips',
          keyframes: [
            { time: 0, x: 0, y: 0, z: 0, w: 1 },
            { time: 2, x: 0, y: sin45, z: 0, w: cos45 },
          ],
        },
      ],
    };
    const result = sampleClip(quatClip, 1.0);
    // scalar must be empty for a quat-only clip
    expect(result.scalar).toEqual({});
    // quat map must have vrm.hips
    expect(result.quat['vrm.hips']).toBeDefined();
    const q = result.quat['vrm.hips'];
    // At t=1 (alpha=0.5), slerp gives 45-degree rotation → |w| ≈ cos(22.5°) ≈ 0.9239
    expect(Math.abs(q.w)).toBeCloseTo(Math.cos(Math.PI / 8), 3);
    // Must be unit quaternion
    const norm = Math.sqrt(q.x ** 2 + q.y ** 2 + q.z ** 2 + q.w ** 2);
    expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
  });
});
