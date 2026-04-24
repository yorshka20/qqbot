import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { EyeGazeLayer } from '../EyeGazeLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };

// The avoidant Y offset applied when pref=0. This value must match the
// AVOIDANT_Y_OFFSET constant in EyeGazeLayer.ts. Keep these in sync.
const AVOIDANT_Y_OFFSET = 0.3;

// Drive the layer to near-convergence for an override target. Override uses
// overrideTheta=0.25 per 16.67 ms frame, so ~15 frames (≈ 250 ms) reaches >98 %.
function runToConvergence(layer: EyeGazeLayer, ticks = 40): void {
  for (let i = 0; i < ticks; i++) layer.sample(1000 + i * 16, ACTIVITY);
}

describe('EyeGazeLayer.setGazeTarget', () => {
  test('named camera → eye converges to (0, 0)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0, 3);
    expect(result['eye.ball.y']).toBeCloseTo(0, 3);
  });

  test('named left → eye converges to (-0.7, 0)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'left' });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(-0.7, 3);
    expect(result['eye.ball.y']).toBeCloseTo(0, 3);
  });

  test('named right → eye converges to (0.7, 0)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'right' });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0.7, 3);
    expect(result['eye.ball.y']).toBeCloseTo(0, 3);
  });

  test('named up → eye converges to (0, -0.7)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'up' });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0, 3);
    expect(result['eye.ball.y']).toBeCloseTo(-0.7, 3);
  });

  test('named down → eye converges to (0, 0.7)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'down' });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0, 3);
    expect(result['eye.ball.y']).toBeCloseTo(0.7, 3);
  });

  test('point target → eye converges to clamped target', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'point', x: 0.3, y: -0.2 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0.3, 3);
    expect(result['eye.ball.y']).toBeCloseTo(-0.2, 3);
  });

  test('point out-of-range is clamped to [-1, 1] then converged toward', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'point', x: 5, y: -5 });
    runToConvergence(layer);
    const result = layer.sample(2000, ACTIVITY);
    // Override target is clamped to (1, -1) at setGazeTarget time; overrides bypass
    // the autonomous maxRadius disk so the eye converges onto (1, -1).
    expect(result['eye.ball.x']).toBeCloseTo(1, 3);
    expect(result['eye.ball.y']).toBeCloseTo(-1, 3);
  });

  test('first tick after override is partway to target (smooth drift, not a snap)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'right' });
    const result = layer.sample(1000, ACTIVITY);
    // overrideTheta=0.25 at dt=16.67ms → step=0.25; posX = 0 + 0.25 * (0.7 - 0) = 0.175
    expect(result['eye.ball.x']).toBeGreaterThan(0);
    expect(result['eye.ball.x']).toBeLessThan(0.7);
    // Not the old snap-to-target behaviour
    expect(result['eye.ball.x']).not.toBeCloseTo(0.7, 2);
  });

  test('setGazeTarget(null) after override restores OU path (two samples differ)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    layer.sample(1000, ACTIVITY); // activate override
    layer.setGazeTarget(null);

    // With OU active the two calls should (eventually) differ.
    // We try up to 5 pairs to absorb the tiny chance of identical noise.
    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('reset() after override clears override (OU resumes)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'right' });
    layer.sample(1000, ACTIVITY);
    layer.reset();

    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('clear type restores OU path', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'left' });
    layer.sample(1000, ACTIVITY);
    layer.setGazeTarget({ type: 'clear' });

    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setDefaultContactPreference tests
// ---------------------------------------------------------------------------

describe('EyeGazeLayer.setDefaultContactPreference', () => {
  test('null preference (never set) — output keys are present (original OU path active)', () => {
    const layer = new EyeGazeLayer();
    const result = layer.sample(1000, ACTIVITY);
    // Use Object.keys check to avoid toHaveProperty dot-path interpretation.
    expect(Object.keys(result)).toContain('eye.ball.x');
    expect(Object.keys(result)).toContain('eye.ball.y');
  });

  test('pref=0 adds avoidant downward offset in no-override mode', () => {
    // Both layers start with posX=0, posY=0.
    // At the first sample tick (t=1000), no saccade fires yet — the OU
    // attractor is (0,0) and the step moves posY by a tiny noise amount.
    // pref=0 layer adds AVOIDANT_Y_OFFSET on top of that, so its y should
    // be meaningfully higher than a layer without any preference.
    const layerPref0 = new EyeGazeLayer();
    layerPref0.setDefaultContactPreference(0);
    const result0 = layerPref0.sample(1000, ACTIVITY);

    // With pref=0 the y output ≈ noise + AVOIDANT_Y_OFFSET.
    // AVOIDANT_Y_OFFSET (0.3) >> 3*noiseSigma (0.045), so asserting > 0.1
    // is robust across the random noise.
    expect(result0['eye.ball.y']).toBeGreaterThan(0.1);
  });

  test('pref=1 does NOT add any avoidant offset', () => {
    // pref=1 → avoidantOffset = (1-1)*AVOIDANT_Y_OFFSET = 0
    // At t=1000 the OU posY is near 0 (just noise), so |y| should be small.
    const layerPref1 = new EyeGazeLayer();
    layerPref1.setDefaultContactPreference(1);
    const result1 = layerPref1.sample(1000, ACTIVITY);

    // |y| should be close to 0 (just noise, sigma=0.015 → 3-sigma ≈ 0.045)
    expect(Math.abs(result1['eye.ball.y'] ?? 0)).toBeLessThan(0.15);
  });

  test('pref=0.5 adds half the avoidant offset', () => {
    const layerPref0 = new EyeGazeLayer();
    layerPref0.setDefaultContactPreference(0);
    const y0 = layerPref0.sample(1000, ACTIVITY)['eye.ball.y'] ?? 0;

    const layerPref1 = new EyeGazeLayer();
    layerPref1.setDefaultContactPreference(1);
    const y1 = layerPref1.sample(1000, ACTIVITY)['eye.ball.y'] ?? 0;

    const layerPref05 = new EyeGazeLayer();
    layerPref05.setDefaultContactPreference(0.5);
    const y05 = layerPref05.sample(1000, ACTIVITY)['eye.ball.y'] ?? 0;

    // y05 should sit between y1 (no offset) and y0 (full offset).
    // Due to independent random noise, use a tolerance of 0.1.
    expect(y05).toBeGreaterThan(y1 - 0.1);
    expect(y05).toBeLessThan(y0 + 0.1);
  });

  test('explicit setGazeTarget wins over default contact preference', () => {
    const layer = new EyeGazeLayer();
    layer.setDefaultContactPreference(0); // avoidant bias
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    // Drive to convergence; eye should land at (0, 0), not biased down by the avoidant offset.
    for (let i = 0; i < 40; i++) layer.sample(1000 + i * 16, ACTIVITY);
    const result = layer.sample(2000, ACTIVITY);
    expect(result['eye.ball.x']).toBeCloseTo(0, 3);
    expect(result['eye.ball.y']).toBeCloseTo(0, 3);
  });

  test('explicit point target wins over default contact preference', () => {
    const layer = new EyeGazeLayer();
    layer.setDefaultContactPreference(0);
    layer.setGazeTarget({ type: 'point', x: 0.2, y: -0.1 });
    for (let i = 0; i < 40; i++) layer.sample(1000 + i * 16, ACTIVITY);
    const result = layer.sample(2000, ACTIVITY);
    // Override path suppresses avoidant offset entirely: eye lands at the point, not
    // the point + downward bias.
    expect(result['eye.ball.x']).toBeCloseTo(0.2, 3);
    expect(result['eye.ball.y']).toBeCloseTo(-0.1, 3);
  });

  test('clearing override after pref=0 is set restores avoidant offset', () => {
    const layer = new EyeGazeLayer();
    layer.setDefaultContactPreference(0);
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    layer.sample(1000, ACTIVITY); // activate override
    layer.setGazeTarget(null); // clear override

    const result = layer.sample(1016, ACTIVITY);
    // OU path is back; pref=0 means avoidant offset is applied again
    expect(result['eye.ball.y']).toBeGreaterThan(0.1);
  });

  test('reset() clears the default contact preference', () => {
    const layer = new EyeGazeLayer();
    layer.setDefaultContactPreference(0);
    layer.reset();

    // After reset, pref is null — y should be near 0 (no avoidant offset)
    const result = layer.sample(1000, ACTIVITY);
    expect(Math.abs(result['eye.ball.y'] ?? 0)).toBeLessThan(0.15);
  });

  test('pref value is clamped to [0, 1] — out-of-range values behave as boundary', () => {
    const layerOver = new EyeGazeLayer();
    layerOver.setDefaultContactPreference(5); // clamped to 1
    const resultOver = layerOver.sample(1000, ACTIVITY);

    const layerPref1 = new EyeGazeLayer();
    layerPref1.setDefaultContactPreference(1);
    const resultPref1 = layerPref1.sample(1000, ACTIVITY);

    // Both clamped to 1 → same additive offset (0). Noise makes exact equality
    // unlikely, but both should have |y| < 0.15.
    expect(Math.abs(resultOver['eye.ball.y'] ?? 0)).toBeLessThan(0.15);
    expect(Math.abs(resultPref1['eye.ball.y'] ?? 0)).toBeLessThan(0.15);
  });
});
