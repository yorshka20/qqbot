import { describe, expect, test } from 'bun:test';
import { computeRmsEnvelope } from '../rms';

describe('computeRmsEnvelope', () => {
  test('sine wave normalizes peak to ~0.95', () => {
    const sampleRate = 16000;
    const freqHz = 100;
    const durationSec = 1;
    const n = sampleRate * durationSec;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pcm[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    }

    const env = computeRmsEnvelope(pcm, sampleRate, { hopMs: 20, windowMs: 30 });
    expect(env.length).toBeGreaterThan(0);

    // With normalize=true the peak should be 0.95
    let peak = 0;
    for (let i = 0; i < env.length; i++) {
      if (env[i] > peak) peak = env[i];
    }
    expect(peak).toBeCloseTo(0.95, 1);

    // Middle samples should be close to 0.95 (sine RMS is uniform)
    const mid = Math.floor(env.length / 2);
    expect(env[mid]).toBeGreaterThan(0.9);
    expect(env[mid]).toBeLessThanOrEqual(0.95 + 0.05);
  });

  test('all-zero input produces all-zero output with no NaN', () => {
    const pcm = new Float32Array(16000); // all zeros
    const env = computeRmsEnvelope(pcm, 16000, { hopMs: 20, windowMs: 30 });
    for (let i = 0; i < env.length; i++) {
      expect(Number.isNaN(env[i])).toBe(false);
      expect(env[i]).toBe(0);
    }
  });

  test('small fixture with manual expected values', () => {
    // hopSamples = round(10*200/1000) = 2
    // windowSamples = round(10*200/1000) = 2
    // halfWin = 1
    // outLen = floor(10/2) = 5
    // For each hop i:
    //   center = i*2, lo = max(0, center-1), hi = min(10, center+1)
    // i=0: center=0, lo=0, hi=1 → samples=[0] → RMS=0
    // i=1: center=2, lo=1, hi=3 → samples=[0,1] → RMS=sqrt((0+1)/2)=sqrt(0.5)≈0.707
    // i=2: center=4, lo=3, hi=5 → samples=[0,-1] → RMS=sqrt((0+1)/2)≈0.707
    // i=3: center=6, lo=5, hi=7 → samples=[0,1] → RMS≈0.707
    // i=4: center=8, lo=7, hi=9 → samples=[0,-1] → RMS≈0.707
    // normalize=false so no peak scaling
    const pcm = new Float32Array([0, 0, 1, 0, -1, 0, 1, 0, -1, 0]);
    const env = computeRmsEnvelope(pcm, 10, { hopMs: 200, windowMs: 200, normalize: false });

    expect(env.length).toBe(5);
    expect(env[0]).toBeCloseTo(0, 5);
    expect(env[1]).toBeCloseTo(Math.sqrt(0.5), 3);
    expect(env[2]).toBeCloseTo(Math.sqrt(0.5), 3);
    expect(env[3]).toBeCloseTo(Math.sqrt(0.5), 3);
    expect(env[4]).toBeCloseTo(Math.sqrt(0.5), 3);
  });

  test('normalize: false — peak is raw RMS, not 0.95', () => {
    const sampleRate = 16000;
    const freqHz = 100;
    const n = sampleRate * 1;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pcm[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    }

    const env = computeRmsEnvelope(pcm, sampleRate, { hopMs: 20, windowMs: 30, normalize: false });
    let peak = 0;
    for (let i = 0; i < env.length; i++) {
      if (env[i] > peak) peak = env[i];
    }
    // Raw sine RMS ≈ 1/sqrt(2) ≈ 0.707, not 0.95
    expect(peak).not.toBeCloseTo(0.95, 1);
    // Peak should be around 0.707 ± some margin
    expect(peak).toBeGreaterThan(0.65);
    expect(peak).toBeLessThan(0.75);
  });
});
