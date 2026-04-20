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
    expect(result['head.yaw']).toBe(0);
    expect(result['body.x']).toBe(1);
  });

  it('at t=1: head.yaw=10 (on kf), body.x≈0 (midpoint interpolation)', () => {
    const result = sampleClip(clip, 1);
    expect(result['head.yaw']).toBe(10);
    // body.x: t=1 is midpoint of [0.5,1.5], easeInOutCubic(0.5)=0.5, value=1+(−1−1)*0.5=0
    expect(Math.abs(result['body.x'])).toBeLessThan(1e-9);
  });

  it('at t=2: head.yaw=0, body.x=-1 (end of clip)', () => {
    const result = sampleClip(clip, 2);
    expect(result['head.yaw']).toBe(0);
    expect(result['body.x']).toBe(-1);
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

  it('empty-tracks clip returns {}', () => {
    const empty: IdleClip = { id: 'e', duration: 1, tracks: [] };
    expect(sampleClip(empty, 0.5)).toEqual({});
  });
});
