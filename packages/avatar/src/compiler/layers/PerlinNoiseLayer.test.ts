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
});
