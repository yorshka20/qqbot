import { describe, expect, test } from 'bun:test';
import { Biquad, designBandpass } from './biquad';

/** Generate a pure sine wave at the given frequency. */
function sine(freqHz: number, durSec: number, sampleRate: number, amp = 1): Float32Array {
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  const twoPiF = 2 * Math.PI * freqHz;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((twoPiF * i) / sampleRate);
  return out;
}

/** Run a signal through a filter, return the output samples. */
function runFilter(filter: Biquad, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = filter.step(input[i]);
  return out;
}

/** RMS of a signal, discarding the first `skip` samples for transient warm-up. */
function rmsSkip(x: Float32Array, skip: number): number {
  let s = 0;
  let n = 0;
  for (let i = skip; i < x.length; i++) {
    s += x[i] * x[i];
    n++;
  }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

describe('designBandpass', () => {
  test('throws on non-positive centerHz', () => {
    expect(() => designBandpass(0, 1, 32000)).toThrow(/centerHz/);
    expect(() => designBandpass(-100, 1, 32000)).toThrow(/centerHz/);
    expect(() => designBandpass(Number.NaN, 1, 32000)).toThrow(/centerHz/);
  });

  test('throws on non-positive q', () => {
    expect(() => designBandpass(1000, 0, 32000)).toThrow(/q/);
    expect(() => designBandpass(1000, -1, 32000)).toThrow(/q/);
  });

  test('throws on non-positive sampleRate', () => {
    expect(() => designBandpass(1000, 1, 0)).toThrow(/sampleRate/);
    expect(() => designBandpass(1000, 1, -32000)).toThrow(/sampleRate/);
  });

  test('produces a0-normalized coefficients (struct has no a0 field)', () => {
    const c = designBandpass(1000, 1.4, 32000);
    expect(Object.keys(c).sort()).toEqual(['a1', 'a2', 'b0', 'b1', 'b2']);
    // b1 is exactly zero for the constant-skirt-gain BPF topology
    expect(c.b1).toBe(0);
  });

  test('center-frequency clamped below Nyquist so no NaN explodes', () => {
    // Request center ABOVE Nyquist; designer should clamp, not divide-by-zero
    const c = designBandpass(100000, 1, 32000);
    for (const v of Object.values(c)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('Biquad — unity gain at center frequency', () => {
  test('500 Hz bandpass passes 500 Hz sine with ~unity gain', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(500, 1.4, sr));
    const input = sine(500, 0.2, sr, 1); // 0.2 s, amp 1
    const output = runFilter(filter, input);

    const inRms = rmsSkip(input, 0);
    const outRms = rmsSkip(output, Math.round(sr * 0.05)); // skip 50 ms warm-up
    const gain = outRms / inRms;
    expect(gain).toBeGreaterThan(0.9);
    expect(gain).toBeLessThan(1.1);
  });

  test('2000 Hz bandpass passes 2000 Hz sine with ~unity gain', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(2000, 1.4, sr));
    const input = sine(2000, 0.1, sr, 1);
    const output = runFilter(filter, input);

    const outRms = rmsSkip(output, Math.round(sr * 0.02));
    expect(outRms).toBeGreaterThan(0.6);
    expect(outRms).toBeLessThan(0.8);
  });
});

describe('Biquad — attenuation off-center', () => {
  test('500 Hz bandpass attenuates 3000 Hz sine', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(500, 1.4, sr));
    const input = sine(3000, 0.1, sr, 1);
    const output = runFilter(filter, input);

    const outRms = rmsSkip(output, Math.round(sr * 0.02));
    expect(outRms).toBeLessThan(0.3);
  });

  test('2000 Hz bandpass attenuates 200 Hz sine', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(2000, 1.4, sr));
    const input = sine(200, 0.2, sr, 1);
    const output = runFilter(filter, input);

    const outRms = rmsSkip(output, Math.round(sr * 0.05));
    expect(outRms).toBeLessThan(0.3);
  });
});

describe('Biquad — state management', () => {
  test('reset() zeros state so subsequent silence produces zero output', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(1000, 1.4, sr));

    // Excite the filter with some noise
    runFilter(filter, sine(1000, 0.05, sr, 1));

    filter.reset();

    const silence = new Float32Array(1000);
    const out = runFilter(filter, silence);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  test('state persists across separate step() calls (no per-call reset)', () => {
    const sr = 32000;
    const filter = new Biquad(designBandpass(1000, 1.4, sr));
    const input = sine(1000, 0.1, sr, 1);

    // Process in one pass
    const filterA = new Biquad(designBandpass(1000, 1.4, sr));
    const outA = runFilter(filterA, input);

    // Process the same signal split across two calls — should be identical
    const halfA = input.subarray(0, input.length / 2);
    const halfB = input.subarray(input.length / 2);
    const outHalfA = runFilter(filter, halfA);
    const outHalfB = runFilter(filter, halfB);

    const outBCombined = new Float32Array(input.length);
    outBCombined.set(outHalfA, 0);
    outBCombined.set(outHalfB, outHalfA.length);

    for (let i = 0; i < input.length; i++) {
      expect(outA[i]).toBeCloseTo(outBCombined[i], 10);
    }
  });
});
