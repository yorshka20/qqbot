import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { HeadLookLayer } from '../HeadLookLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };

// Drive the layer ~30 frames at 16 ms each — ≥ 98 % convergence for overrideTheta=0.15.
function runToConvergence(layer: HeadLookLayer, ticks = 50): void {
  for (let i = 0; i < ticks; i++) layer.sample(1000 + i * 16, ACTIVITY);
}

describe('HeadLookLayer — baseline / no override', () => {
  test('no override, first sample emits nothing', () => {
    const layer = new HeadLookLayer();
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({});
  });

  test('no override stays silent across many ticks', () => {
    const layer = new HeadLookLayer();
    for (let i = 0; i < 20; i++) {
      const result = layer.sample(1000 + i * 16, ACTIVITY);
      expect(result).toEqual({});
    }
  });
});

describe('HeadLookLayer — setHeadLook override', () => {
  test('yaw-only override drives head.yaw and leaves head.pitch absent', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: -15 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['head.yaw']).toBeCloseTo(-15, 1);
    expect(result['head.pitch']).toBeUndefined();
  });

  test('pitch-only override drives head.pitch and leaves head.yaw absent', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ pitch: 10 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['head.pitch']).toBeCloseTo(10, 1);
    expect(result['head.yaw']).toBeUndefined();
  });

  test('both axes set → both channels converge', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: 12, pitch: -8 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['head.yaw']).toBeCloseTo(12, 1);
    expect(result['head.pitch']).toBeCloseTo(-8, 1);
  });

  test('first tick after override is partway to target (smooth drift, not snap)', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: 20 });
    const result = layer.sample(1000, ACTIVITY);
    // theta=0.15 at dt=16.67 → step=0.15; yaw = 0 + 0.15 * (20 - 0) = 3
    expect(result['head.yaw']).toBeGreaterThan(0);
    expect(result['head.yaw']).toBeLessThan(20);
  });

  test('out-of-range values are clamped to ±30°', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: 999, pitch: -999 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['head.yaw']).toBeCloseTo(30, 1);
    expect(result['head.pitch']).toBeCloseTo(-30, 1);
  });
});

describe('HeadLookLayer — release / rest', () => {
  test('setHeadLook(null) drifts back to zero and then stops emitting', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: 20 });
    runToConvergence(layer);
    expect(layer.sample(2000, ACTIVITY)['head.yaw']).toBeCloseTo(20, 1);

    // Release: eye drifts back toward 0
    layer.setHeadLook(null);
    // Enough ticks for restTheta=0.12 to drive near-zero
    for (let i = 0; i < 100; i++) layer.sample(3000 + i * 16, ACTIVITY);

    const finalResult = layer.sample(5000, ACTIVITY);
    // At rest the layer emits nothing — absent keys, not zeros.
    expect(finalResult).toEqual({});
  });

  test('reset() clears override and history', () => {
    const layer = new HeadLookLayer();
    layer.setHeadLook({ yaw: 15 });
    runToConvergence(layer);
    layer.reset();
    const result = layer.sample(2000, ACTIVITY);
    expect(result).toEqual({});
  });
});

describe('HeadLookLayer — additivity with other head writers', () => {
  test('layer does NOT declare scalarIsAbsolute (envelope actions on head.yaw add, not override)', () => {
    // This is a contract check: HeadLookLayer must be additive so that a shake_head
    // action (head.yaw oscillation via the envelope pipeline) stacks on top of a
    // HeadLook offset instead of being silently dropped.
    const layer = new HeadLookLayer();
    // scalarIsAbsolute is inherited from BaseLayer — HeadLookLayer must NOT override
    // it to true. The default is undefined, which LayerManager treats as additive.
    expect((layer as unknown as { scalarIsAbsolute?: boolean }).scalarIsAbsolute).toBeFalsy();
  });
});
