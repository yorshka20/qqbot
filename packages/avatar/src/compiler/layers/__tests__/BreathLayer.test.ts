/**
 * BreathLayer.setRate() tests — verify that the runtime frequency multiplier
 * changes waveform phase progression while keeping output finite and centered,
 * and that the clamp/sanitize contract is enforced.
 *
 * The `breath` channel (amplitude=0.5, periodSec=3.5, phase=0, center=0.5,
 * no harmonics) is used as the probe channel for all rate comparisons because
 * its waveform is a pure sine, making expected values easy to reason about.
 * Multi-harmonic channels (head.yaw etc.) are checked only for finiteness.
 */
import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { BreathLayer } from '../BreathLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1.0 };

describe('BreathLayer.setRate — waveform frequency semantics', () => {
  test('setRate(1.0) is identity — output is bit-for-bit identical to default', () => {
    const explicit = new BreathLayer();
    explicit.setRate(1.0);
    const def = new BreathLayer();

    for (const t of [0, 500, 1000, 4000, 10_000, 60_000]) {
      const e = explicit.sample(t, ACTIVITY);
      const d = def.sample(t, ACTIVITY);
      for (const ch of Object.keys(d)) {
        expect(e[ch]).toBeCloseTo(d[ch], 10);
      }
    }
  });

  test('setRate(2.0): layer at t equals default layer at 2t (doubles temporal frequency)', () => {
    // Because rate=2 multiplies omega by 2, the phase at real-time t is the same
    // as the default layer's phase at 2t. This is the exact semantic guarantee.
    const fast = new BreathLayer();
    fast.setRate(2.0);
    const def = new BreathLayer();

    for (const tSec of [1, 2, 3, 5]) {
      const t = tSec * 1000;
      expect(fast.sample(t, ACTIVITY)['breath']).toBeCloseTo(def.sample(t * 2, ACTIVITY)['breath'], 8);
    }
  });

  test('setRate(0.5): layer at t equals default layer at 0.5t (halves temporal frequency)', () => {
    const slow = new BreathLayer();
    slow.setRate(0.5);
    const def = new BreathLayer();

    for (const tSec of [2, 4, 6, 10]) {
      const t = tSec * 1000;
      expect(slow.sample(t, ACTIVITY)['breath']).toBeCloseTo(def.sample(t * 0.5, ACTIVITY)['breath'], 8);
    }
  });

  test('faster rate produces measurably different value at same timestamp vs default', () => {
    const fast = new BreathLayer();
    fast.setRate(2.0);
    const def = new BreathLayer();

    // At t=1s with rate=2, ω·t = 2×(2π/3.5) ≈ 3.59 rad vs default ω·t ≈ 1.795 rad.
    const t = 1000;
    expect(fast.sample(t, ACTIVITY)['breath']).not.toBeCloseTo(def.sample(t, ACTIVITY)['breath'], 4);
  });

  test('slower rate produces measurably different value at same timestamp vs default', () => {
    const slow = new BreathLayer();
    slow.setRate(0.5);
    const def = new BreathLayer();

    const t = 4000; // 4 s — enough arc to distinguish at 0.5× vs 1×
    expect(slow.sample(t, ACTIVITY)['breath']).not.toBeCloseTo(def.sample(t, ACTIVITY)['breath'], 4);
  });

  test('amplitudes and centers are unchanged — breath stays in [0, 1] at all rates', () => {
    for (const rate of [0.2, 0.5, 1.0, 2.0, 3.0]) {
      const layer = new BreathLayer();
      layer.setRate(rate);
      for (let t = 0; t <= 60_000; t += 250) {
        const v = layer.sample(t, ACTIVITY)['breath'];
        expect(Number.isFinite(v)).toBe(true);
        // breath: center=0.5, amplitude=0.5 → range [0, 1]
        expect(v).toBeGreaterThanOrEqual(-0.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
    }
  });

  test('all channels remain finite at extreme rates', () => {
    for (const rate of [0.2, 3.0]) {
      const layer = new BreathLayer();
      layer.setRate(rate);
      for (let t = 0; t <= 30_000; t += 1000) {
        const out = layer.sample(t, ACTIVITY);
        for (const v of Object.values(out)) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });
});

describe('BreathLayer.setRate — clamp / invalid input', () => {
  test('0.0 is clamped to 0.2 — output still advances (not frozen)', () => {
    const layer = new BreathLayer();
    layer.setRate(0.0);
    const clamped = new BreathLayer();
    clamped.setRate(0.2);
    // Clamped-to-0.2 layer and 0.0-input layer must match exactly
    for (const t of [0, 1000, 10_000]) {
      expect(layer.sample(t, ACTIVITY)['breath']).toBeCloseTo(clamped.sample(t, ACTIVITY)['breath'], 10);
    }
  });

  test('negative value is clamped to 0.2 (floor, not sign flip)', () => {
    const layer = new BreathLayer();
    layer.setRate(-100);
    const floor = new BreathLayer();
    floor.setRate(0.2);
    for (const t of [0, 1000, 10_000]) {
      expect(layer.sample(t, ACTIVITY)['breath']).toBeCloseTo(floor.sample(t, ACTIVITY)['breath'], 10);
    }
  });

  test('100 is clamped to 3.0 — matches explicit setRate(3.0)', () => {
    const clamped = new BreathLayer();
    clamped.setRate(100);
    const exact = new BreathLayer();
    exact.setRate(3.0);
    for (const t of [0, 1000, 4000]) {
      expect(clamped.sample(t, ACTIVITY)['breath']).toBeCloseTo(exact.sample(t, ACTIVITY)['breath'], 10);
    }
  });

  test('NaN is a no-op — _rate stays at default 1.0', () => {
    // Math.max(0.2, NaN) → NaN in JS. Guard: non-finite input is ignored so
    // the previous _rate (1.0 on a fresh layer) is preserved.
    const layer = new BreathLayer();
    layer.setRate(Number.NaN);
    const def = new BreathLayer();
    for (const t of [0, 1000, 4000]) {
      expect(layer.sample(t, ACTIVITY)['breath']).toBeCloseTo(def.sample(t, ACTIVITY)['breath'], 10);
    }
  });

  test('Infinity is clamped to 3.0', () => {
    const layer = new BreathLayer();
    layer.setRate(Infinity);
    const exact = new BreathLayer();
    exact.setRate(3.0);
    for (const t of [0, 1000, 4000]) {
      expect(layer.sample(t, ACTIVITY)['breath']).toBeCloseTo(exact.sample(t, ACTIVITY)['breath'], 10);
    }
  });
});
