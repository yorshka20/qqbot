import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { EyeGazeLayer } from '../EyeGazeLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };

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
// setGazeDistribution tests
// ---------------------------------------------------------------------------

describe('EyeGazeLayer.setGazeDistribution', () => {
  // saccadeIntervalMax = 10000ms; advance by 11000ms to guarantee a saccade fires.
  // Autonomous theta=0.08 per 16.67ms tick — slow convergence. Use 60 ticks (~1s) for
  // reliable convergence within 0.05 of target.
  const TICKS_PER_CYCLE = 60;
  const cap = 0.6; // maxRadius

  test('camera-only distribution → saccades cluster near origin', () => {
    // Camera targets are within 0.15*cap ≈ 0.09 of origin. OU noise (σ_ss ≈ 0.037)
    // means individual samples can exceed 0.09, so we average over 10 cycles.
    // With 10 samples, avg|x| ≈ 0.037 and threshold 0.12 is ≈7σ away — highly reliable.
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 1, side: 0, down: 0 });
    let now = 0;
    let sumAbsX = 0;
    let sumAbsY = 0;
    const numCycles = 10;
    for (let cycle = 0; cycle < numCycles; cycle++) {
      now += 11000;
      let result: Record<string, number> = {};
      for (let i = 0; i < TICKS_PER_CYCLE; i++) {
        now += 16;
        result = layer.sample(now, ACTIVITY);
      }
      sumAbsX += Math.abs(result['eye.ball.x'] ?? 0);
      sumAbsY += Math.abs(result['eye.ball.y'] ?? 0);
    }
    expect(sumAbsX / numCycles).toBeLessThan(0.12);
    expect(sumAbsY / numCycles).toBeLessThan(0.12);
  });

  test('side-only distribution → saccades have large |x| and small |y|', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 0, side: 1, down: 0 });
    let now = 0;
    // Run multiple cycles; after convergence most samples should show |x| >> |y|
    let xSumAbs = 0;
    let ySumAbs = 0;
    const cycleCount = 8;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
      now += 11000;
      let result: Record<string, number> = {};
      for (let i = 0; i < TICKS_PER_CYCLE; i++) {
        now += 16;
        result = layer.sample(now, ACTIVITY);
      }
      xSumAbs += Math.abs(result['eye.ball.x'] ?? 0);
      ySumAbs += Math.abs(result['eye.ball.y'] ?? 0);
    }
    const avgX = xSumAbs / cycleCount;
    const avgY = ySumAbs / cycleCount;
    // Side targets are 0.55–0.95 * cap in |x|; camera-center is ~0 in |x|.
    // After convergence avg |x| should significantly exceed avg |y|.
    expect(avgX).toBeGreaterThan(avgY * 1.5);
    expect(avgX).toBeGreaterThan(cap * 0.2);
  });

  test('down-only distribution → saccades have positive y (downward) and small |x|', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 0, side: 0, down: 1 });
    let now = 0;
    let ySumPositive = 0;
    const cycleCount = 8;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
      now += 11000;
      let result: Record<string, number> = {};
      for (let i = 0; i < TICKS_PER_CYCLE; i++) {
        now += 16;
        result = layer.sample(now, ACTIVITY);
      }
      ySumPositive += result['eye.ball.y'] ?? 0;
    }
    const avgY = ySumPositive / cycleCount;
    // Down targets: y = 0.6–1.0 * cap (positive = down)
    expect(avgY).toBeGreaterThan(cap * 0.25);
  });

  test('normalization: {camera:5,side:5} → saccades split ~50/50 between kinds', () => {
    // Use fresh layers (one saccade each) with real randomness + 60-tick convergence.
    // camera target: |x| ≤ 0.15*cap ≈ 0.09; side target: |x| ≥ 0.55*cap ≈ 0.33.
    // Threshold 0.20 is cleanly between these ranges.
    let cameraSaccades = 0;
    let sideSaccades = 0;
    const n = 200;
    const threshold = 0.2;

    for (let i = 0; i < n; i++) {
      const layer = new EyeGazeLayer();
      layer.setGazeDistribution({ camera: 5, side: 5 });
      // Init nextSaccadeAt on first sample
      layer.sample(0, ACTIVITY);
      // Force saccade (advance past saccadeIntervalMax=10000ms)
      let now = 11000;
      layer.sample(now, ACTIVITY);
      // Converge OU to the saccade target (60 ticks × 16ms = 960ms < 3000ms min interval)
      let result: Record<string, number> = {};
      for (let t = 0; t < 60; t++) {
        now += 16;
        result = layer.sample(now, ACTIVITY);
      }
      if (Math.abs(result['eye.ball.x'] ?? 0) < threshold) {
        cameraSaccades++;
      } else {
        sideSaccades++;
      }
    }

    // 50/50 expected; threshold of 35% is 3σ away from mean (n=200, σ≈7)
    expect(cameraSaccades).toBeGreaterThan(n * 0.35);
    expect(sideSaccades).toBeGreaterThan(n * 0.35);
  });

  test('back-compat: setDefaultContactPreference(0.7) delegates to {camera:0.7,side:0.3}', () => {
    // Fresh layer per saccade; 70% camera (|x|<0.20), 30% side (|x|≥0.20) expected.
    let cameraSaccades = 0;
    let sideSaccades = 0;
    const n = 200;
    const threshold = 0.2;

    for (let i = 0; i < n; i++) {
      const layer = new EyeGazeLayer();
      layer.setDefaultContactPreference(0.7);
      layer.sample(0, ACTIVITY);
      let now = 11000;
      layer.sample(now, ACTIVITY);
      let result: Record<string, number> = {};
      for (let t = 0; t < 60; t++) {
        now += 16;
        result = layer.sample(now, ACTIVITY);
      }
      if (Math.abs(result['eye.ball.x'] ?? 0) < threshold) {
        cameraSaccades++;
      } else {
        sideSaccades++;
      }
    }

    // 70% camera expected; side ~30%
    expect(cameraSaccades).toBeGreaterThan(n * 0.55); // mean 140, threshold 110 = mean-2.1σ
    expect(sideSaccades).toBeGreaterThan(n * 0.15); // mean 60,  threshold 30  = mean-3.9σ
  });

  test('setGazeDistribution(null) after non-null → eye position varies (OU resumes)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 1 });
    layer.sample(1000, ACTIVITY);
    layer.setGazeDistribution(null);

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

  test('reset() clears the distribution (vanilla OU disk sampling resumes)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 1 });
    layer.reset();

    // After reset, distribution is null; the OU path runs vanilla disk sampling.
    // Eye position should vary (OU noise) rather than being clamped to camera-only.
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

  test('sum=0 distribution treated as null (vanilla path)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeDistribution({ camera: 0, side: 0, down: 0, target: 0 });

    // Should behave like null distribution — OU noise active
    let found = false;
    let t = 1000;
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
