import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../state/types';
import { PerlinNoiseLayer } from './PerlinNoiseLayer';

const IDLE = DEFAULT_ACTIVITY;

describe('PerlinNoiseLayer', () => {
  describe('continuity', () => {
    test('adjacent head.yaw deltas stay < 0.3 over 100 frames at 16.67ms steps', () => {
      const layer = new PerlinNoiseLayer();
      let prev = layer.sample(0, IDLE)['head.yaw'] ?? 0;
      let ok = true;
      for (let i = 1; i <= 100; i++) {
        const now = i * 16.67;
        const cur = layer.sample(now, IDLE)['head.yaw'] ?? 0;
        if (Math.abs(cur - prev) >= 0.3) ok = false;
        prev = cur;
      }
      expect(ok).toBe(true);
    });
  });

  describe('amplitude bounds', () => {
    test('head.yaw stays in [-2.5, 2.5] over many timestamps within 10 minutes', () => {
      const layer = new PerlinNoiseLayer();
      let ok = true;
      for (let t = 0; t <= 10 * 60 * 1000; t += 500) {
        const v = layer.sample(t, IDLE)['head.yaw'] ?? 0;
        if (v < -2.5 || v > 2.5) ok = false;
      }
      expect(ok).toBe(true);
    });

    test('body.x stays in [-0.05, 0.05] over many timestamps within 10 minutes', () => {
      const layer = new PerlinNoiseLayer();
      let ok = true;
      for (let t = 0; t <= 10 * 60 * 1000; t += 500) {
        const v = layer.sample(t, IDLE)['body.x'] ?? 0;
        if (v < -0.05 || v > 0.05) ok = false;
      }
      expect(ok).toBe(true);
    });
  });

  describe('channel independence', () => {
    test('head.yaw and head.pitch are not always equal at identical sample times', () => {
      const layer = new PerlinNoiseLayer();
      let different = false;
      for (let t = 0; t < 5000; t += 100) {
        const yaw = layer.sample(t, IDLE)['head.yaw'] ?? 0;
        const pitch = layer.sample(t, IDLE)['head.pitch'] ?? 0;
        if (yaw !== pitch) {
          different = true;
          break;
        }
      }
      expect(different).toBe(true);
    });
  });

  describe('determinism', () => {
    test('two layers with same options give toEqual on same nowMs', () => {
      const a = new PerlinNoiseLayer();
      const b = new PerlinNoiseLayer();
      for (const t of [0, 100, 1000, 50000]) {
        expect(a.sample(t, IDLE)).toEqual(b.sample(t, IDLE));
      }
    });
  });

  describe('channel override', () => {
    test('{ channels: { head.yaw: { amplitude: 0 } } } makes head.yaw === 0', () => {
      const layer = new PerlinNoiseLayer({
        channels: { 'head.yaw': { amplitude: 0 } },
      });
      for (let t = 0; t < 5000; t += 100) {
        expect(layer.sample(t, IDLE)['head.yaw']).toBeCloseTo(0, 5);
      }
    });

    test('other channels still emit when head.yaw amplitude is 0', () => {
      const layer = new PerlinNoiseLayer({
        channels: { 'head.yaw': { amplitude: 0 } },
      });
      const result = layer.sample(1234, IDLE);
      expect(result['head.pitch']).not.toBeNaN();
      expect(result['head.roll']).not.toBeNaN();
      expect(result['body.x']).not.toBeNaN();
      expect(result['body.y']).not.toBeNaN();
    });
  });

  describe('finite numbers', () => {
    test('all outputs are finite numbers over repeated sampling', () => {
      const layer = new PerlinNoiseLayer();
      let ok = true;
      for (let t = 0; t < 20000; t += 50) {
        const vals = layer.sample(t, IDLE);
        for (const v of Object.values(vals)) {
          if (!Number.isFinite(v)) ok = false;
        }
      }
      expect(ok).toBe(true);
    });
  });

  describe('output key set', () => {
    test('output keys are exactly head.yaw, head.pitch, head.roll, body.x, body.y', () => {
      const layer = new PerlinNoiseLayer();
      const keys = Object.keys(layer.sample(0, IDLE)).sort();
      expect(keys).toEqual(['body.x', 'body.y', 'head.pitch', 'head.roll', 'head.yaw']);
    });
  });

  describe('activity envelope — pauses', () => {
    // When the slow envelope perlin sits below `envPauseBelow`, the channel
    // output is multiplied by 0 and the head should be fully still. Verify
    // at least one sustained multi-second pause window exists on head.yaw
    // within a 10-minute sample — otherwise the envelope isn't producing
    // real stops, just attenuating, which is what the user was complaining
    // about ("head keeps rotating, never stops").
    test('head.yaw has at least one 2s window of near-zero output within 10 minutes', () => {
      const layer = new PerlinNoiseLayer();
      const stepMs = 100;
      const windowSamples = Math.round(2000 / stepMs);
      const threshold = 0.02;

      let maxInWindow = Infinity;
      let pausedWindowFound = false;
      const recent: number[] = [];
      for (let t = 0; t <= 10 * 60 * 1000; t += stepMs) {
        const v = Math.abs(layer.sample(t, IDLE)['head.yaw'] ?? 0);
        recent.push(v);
        if (recent.length > windowSamples) recent.shift();
        if (recent.length === windowSamples) {
          maxInWindow = Math.max(...recent);
          if (maxInWindow < threshold) {
            pausedWindowFound = true;
            break;
          }
        }
      }
      expect(pausedWindowFound).toBe(true);
    });

    test('overall activity duty cycle is below ~65% (pauses + attenuation keep head still a meaningful fraction of time)', () => {
      const layer = new PerlinNoiseLayer();
      // "Active" = output magnitude at least 10% of peak amplitude. With the
      // envelope thresholds biased toward pausing, well under 65% of samples
      // should be active over a long window. If this ratio ever climbs back
      // toward 1.0 the envelope has been silently disabled.
      let active = 0;
      let total = 0;
      for (let t = 0; t <= 10 * 60 * 1000; t += 100) {
        const v = Math.abs(layer.sample(t, IDLE)['head.yaw'] ?? 0);
        if (v > 0.2) active++;
        total++;
      }
      const ratio = active / total;
      expect(ratio).toBeLessThan(0.65);
    });
  });

  describe('activity envelope — amplitude variation', () => {
    // Split a long run into windows and assert the per-window peak varies
    // substantially. This catches regressions where the envelope collapses
    // to a constant (e.g. always 1), which would make every window reach
    // the same ~peak amplitude.
    test('per-window peak head.yaw varies substantially across a 10-minute run', () => {
      const layer = new PerlinNoiseLayer();
      const stepMs = 100;
      // 10s windows are narrower than the longest pause runs, so the quietest
      // window should sit fully inside a pause and have peak ≈ 0. Wider
      // windows inevitably straddle a pause/active boundary and inflate the
      // min peak, obscuring the variation we want to test.
      const windowMs = 10_000;
      const windowSamples = Math.round(windowMs / stepMs);
      const peaks: number[] = [];
      let current: number[] = [];
      for (let t = 0; t <= 10 * 60 * 1000; t += stepMs) {
        current.push(Math.abs(layer.sample(t, IDLE)['head.yaw'] ?? 0));
        if (current.length === windowSamples) {
          peaks.push(Math.max(...current));
          current = [];
        }
      }

      const minPeak = Math.min(...peaks);
      const maxPeak = Math.max(...peaks);
      // A healthy envelope should produce some windows where the peak is
      // near zero (pause-dominated) and others near full amplitude. If the
      // envelope ever collapses to a constant the peak becomes uniform
      // across windows and this spread vanishes.
      expect(minPeak).toBeLessThan(0.1);
      expect(maxPeak).toBeGreaterThan(1.2);
      expect(maxPeak - minPeak).toBeGreaterThan(1.0);
    });
  });

  describe('envelope override', () => {
    // Setting `envActiveAbove` below the minimum raw perlin output forces
    // envelope = 1 always → layer falls back to the pre-envelope behaviour.
    // This is the escape hatch for callers (tests, tunable experiments)
    // that want the old constant-motion characteristic.
    test('envActiveAbove = -10 makes envelope always full → output saturates to ±amplitude peaks', () => {
      const layer = new PerlinNoiseLayer({
        channels: {
          'head.yaw': { envPauseBelow: -20, envActiveAbove: -10 },
        },
      });
      let maxAbs = 0;
      for (let t = 0; t <= 10 * 60 * 1000; t += 200) {
        const v = Math.abs(layer.sample(t, IDLE)['head.yaw'] ?? 0);
        if (v > maxAbs) maxAbs = v;
      }
      // Without envelope attenuation, head.yaw peaks should reach close to
      // the configured amplitude (2.0) on at least some samples.
      expect(maxAbs).toBeGreaterThan(1.5);
    });
  });
});
