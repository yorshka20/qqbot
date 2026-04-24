/**
 * AutoBlinkLayer.setRate() tests — verify that the runtime frequency multiplier
 * makes blink phases arrive sooner (faster rate) or later (slower rate) while
 * preserving the correct eye-open/closed contract, and that clamp/sanitize
 * behavior is enforced.
 *
 * Math.random() is stubbed via spyOn where interval randomness would make
 * assertions flaky. The phase-progression tests set Math.random = () => 0 so
 * that randomInterval() returns intervalMin / _rate — fully deterministic.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { AutoBlinkLayer } from '../AutoBlinkLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1.0 };

/** Default config constants, mirrored here to avoid importing the private object. */
const DEFAULTS = {
  intervalMin: 2000,
  intervalMax: 8000,
  closingMs: 80,
  closedMs: 60,
  openingMs: 140,
};

describe('AutoBlinkLayer.setRate — identity', () => {
  test('setRate(1.0) is identity — blink timing matches a default layer exactly', () => {
    // Stub Math.random to 0 so both layers schedule identical first blink.
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const explicit = new AutoBlinkLayer();
      explicit.setRate(1.0);
      const def = new AutoBlinkLayer();

      // Advance through one complete blink cycle at 40 ms ticks.
      for (let t = 0; t <= 5000; t += 40) {
        const e = explicit.sample(t, ACTIVITY);
        const d = def.sample(t, ACTIVITY);
        expect(e['eye.open.left']).toBeCloseTo(d['eye.open.left'], 10);
        expect(e['eye.open.right']).toBeCloseTo(d['eye.open.right'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AutoBlinkLayer.setRate — phase timing', () => {
  /**
   * Helpers: advance a fresh layer tick-by-tick from t=0 in 1ms steps and
   * return the first timestamp at which the layer is in the given phase
   * (detected by watching closure leave 0 or reach 1).
   *
   * With Math.random() = 0, the first blink is scheduled at:
   *   nextBlinkAt = 0 + intervalMin / _rate
   * So at time `intervalMin / _rate` the layer enters 'closing'.
   */
  function firstBlinkStart(layer: AutoBlinkLayer): number {
    // First tick seeds nextBlinkAt.
    layer.sample(0, ACTIVITY);
    // Now step forward 1 ms at a time until eyes start closing (closure > 0)
    for (let t = 1; t <= 20_000; t += 1) {
      const out = layer.sample(t, ACTIVITY);
      if (out['eye.open.left'] < 1.0) return t;
    }
    return -1; // not found within 20 s
  }

  function firstEyesFullyClosed(layer: AutoBlinkLayer): number {
    layer.sample(0, ACTIVITY);
    for (let t = 1; t <= 20_000; t += 1) {
      const out = layer.sample(t, ACTIVITY);
      if (out['eye.open.left'] <= 0.001) return t;
    }
    return -1;
  }

  test('faster rate (2.0) starts blink sooner than default', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const fast = new AutoBlinkLayer();
      fast.setRate(2.0);
      const def = new AutoBlinkLayer();

      const fastStart = firstBlinkStart(fast);
      const defStart = firstBlinkStart(def);

      expect(fastStart).toBeGreaterThan(0);
      expect(defStart).toBeGreaterThan(0);
      expect(fastStart).toBeLessThan(defStart);
    } finally {
      spy.mockRestore();
    }
  });

  test('slower rate (0.5) starts blink later than default', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const slow = new AutoBlinkLayer();
      slow.setRate(0.5);
      const def = new AutoBlinkLayer();

      const slowStart = firstBlinkStart(slow);
      const defStart = firstBlinkStart(def);

      expect(slowStart).toBeGreaterThan(0);
      expect(defStart).toBeGreaterThan(0);
      expect(slowStart).toBeGreaterThan(defStart);
    } finally {
      spy.mockRestore();
    }
  });

  test('faster rate (2.0) reaches fully-closed phase sooner than default', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const fast = new AutoBlinkLayer();
      fast.setRate(2.0);
      const def = new AutoBlinkLayer();

      const fastClosed = firstEyesFullyClosed(fast);
      const defClosed = firstEyesFullyClosed(def);

      expect(fastClosed).toBeGreaterThan(0);
      expect(defClosed).toBeGreaterThan(0);
      expect(fastClosed).toBeLessThan(defClosed);
    } finally {
      spy.mockRestore();
    }
  });

  test('at rate=2.0 first-blink timestamp is exactly intervalMin/2', () => {
    // With Math.random()=0, nextBlinkAt = intervalMin / rate = 2000/2 = 1000 ms.
    // At t=nextBlinkAt the phase transitions to 'closing' with elapsed=0 (closure=0,
    // eye still at 1). One tick later (t+1) closure is nonzero, so eye.open < 1.
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const fast = new AutoBlinkLayer();
      fast.setRate(2.0);
      fast.sample(0, ACTIVITY); // seed: nextBlinkAt = 1000
      // t=999: still in open phase
      expect(fast.sample(999, ACTIVITY)['eye.open.left']).toBeCloseTo(1.0, 6);
      // t=1000: enters closing with elapsed=0 → closure=0, eye.open still 1
      fast.sample(1000, ACTIVITY); // transition tick
      // t=1001: 1ms into closing → closure=1/40 → eye.open < 1
      expect(fast.sample(1001, ACTIVITY)['eye.open.left']).toBeLessThan(1.0);
    } finally {
      spy.mockRestore();
    }
  });

  test('at default rate first-blink timestamp is exactly intervalMin', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const def = new AutoBlinkLayer();
      def.sample(0, ACTIVITY); // seed: nextBlinkAt = 2000
      expect(def.sample(DEFAULTS.intervalMin - 1, ACTIVITY)['eye.open.left']).toBeCloseTo(1.0, 6);
      def.sample(DEFAULTS.intervalMin, ACTIVITY); // transition tick
      // One tick after nextBlinkAt — closure > 0
      expect(def.sample(DEFAULTS.intervalMin + 1, ACTIVITY)['eye.open.left']).toBeLessThan(1.0);
    } finally {
      spy.mockRestore();
    }
  });

  test('at rate=2.0 closing phase completes in closingMs/2', () => {
    // closingMs=80, at rate=2 → effective closing duration = 40 ms.
    // We step t=0 → t=1000 (enters closing at phaseStartMs=1000) → t=1039 (1ms
    // before threshold) → t=1040 (threshold reached, eyes fully closed).
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const fast = new AutoBlinkLayer();
      fast.setRate(2.0);
      fast.sample(0, ACTIVITY); // seed: nextBlinkAt=1000
      fast.sample(1000, ACTIVITY); // enters 'closing' at phaseStartMs=1000
      // elapsed=39 at t=1039: 39 < 40, still closing, closure=39/40, eye.open=1/40>0
      const notClosed = fast.sample(1039, ACTIVITY)['eye.open.left'];
      expect(notClosed).toBeGreaterThan(0);
      expect(notClosed).toBeLessThan(1);
      // elapsed=40 at t=1040: 40 >= 40 → enters 'closed', closure=1, eye.open=0
      const closed = fast.sample(1040, ACTIVITY)['eye.open.left'];
      expect(closed).toBeCloseTo(0, 6);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AutoBlinkLayer.setRate — output validity', () => {
  test('eye.open values always stay in [0, 1] regardless of rate', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      for (const rate of [0.2, 0.5, 1.0, 2.0, 3.0]) {
        const layer = new AutoBlinkLayer();
        layer.setRate(rate);
        for (let t = 0; t <= 30_000; t += 10) {
          const out = layer.sample(t, ACTIVITY);
          expect(out['eye.open.left']).toBeGreaterThanOrEqual(0);
          expect(out['eye.open.left']).toBeLessThanOrEqual(1);
          expect(out['eye.open.right']).toBeGreaterThanOrEqual(0);
          expect(out['eye.open.right']).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('left and right eye values are always equal', () => {
    const layer = new AutoBlinkLayer();
    layer.setRate(1.5);
    for (let t = 0; t <= 20_000; t += 50) {
      const out = layer.sample(t, ACTIVITY);
      expect(out['eye.open.left']).toBeCloseTo(out['eye.open.right'], 10);
    }
  });
});

describe('AutoBlinkLayer.setRate — clamp / invalid input', () => {
  test('0.0 is clamped to 0.2 — matches explicit setRate(0.2)', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const zero = new AutoBlinkLayer();
      zero.setRate(0.0);
      const floor = new AutoBlinkLayer();
      floor.setRate(0.2);
      for (let t = 0; t <= 20_000; t += 100) {
        expect(zero.sample(t, ACTIVITY)['eye.open.left']).toBeCloseTo(floor.sample(t, ACTIVITY)['eye.open.left'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('negative value is clamped to 0.2', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const neg = new AutoBlinkLayer();
      neg.setRate(-10);
      const floor = new AutoBlinkLayer();
      floor.setRate(0.2);
      for (let t = 0; t <= 20_000; t += 100) {
        expect(neg.sample(t, ACTIVITY)['eye.open.left']).toBeCloseTo(floor.sample(t, ACTIVITY)['eye.open.left'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('100 is clamped to 3.0 — matches explicit setRate(3.0)', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const big = new AutoBlinkLayer();
      big.setRate(100);
      const cap = new AutoBlinkLayer();
      cap.setRate(3.0);
      for (let t = 0; t <= 5_000; t += 10) {
        expect(big.sample(t, ACTIVITY)['eye.open.left']).toBeCloseTo(cap.sample(t, ACTIVITY)['eye.open.left'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('NaN is a no-op — _rate stays at default 1.0', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const nanLayer = new AutoBlinkLayer();
      nanLayer.setRate(Number.NaN);
      const def = new AutoBlinkLayer();
      for (let t = 0; t <= 5_000; t += 40) {
        expect(nanLayer.sample(t, ACTIVITY)['eye.open.left']).toBeCloseTo(def.sample(t, ACTIVITY)['eye.open.left'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('Infinity is clamped to 3.0', () => {
    const spy = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const inf = new AutoBlinkLayer();
      inf.setRate(Infinity);
      const cap = new AutoBlinkLayer();
      cap.setRate(3.0);
      for (let t = 0; t <= 5_000; t += 10) {
        expect(inf.sample(t, ACTIVITY)['eye.open.left']).toBeCloseTo(cap.sample(t, ACTIVITY)['eye.open.left'], 10);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
