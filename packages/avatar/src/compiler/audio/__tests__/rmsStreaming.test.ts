import { describe, expect, test } from 'bun:test';
import { RmsStreamer } from '../rmsStreaming';

const SAMPLE_RATE = 16000;
const HOP_MS = 20;

/** Generate a simple ramp signal of given length. */
function makeRamp(length: number): Float32Array {
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i++) arr[i] = (i % 100) / 100;
  return arr;
}

describe('RmsStreamer', () => {
  test('one push of full PCM vs two halves yields exactly equal frames', () => {
    const pcm = makeRamp(8000); // 0.5s at 16kHz

    // One-shot
    const streamerFull = new RmsStreamer({ hopMs: HOP_MS });
    const framesFull = streamerFull.push(pcm, SAMPLE_RATE);

    // Two halves
    const streamerHalved = new RmsStreamer({ hopMs: HOP_MS });
    const half = Math.floor(pcm.length / 2);
    const framesA = streamerHalved.push(pcm.slice(0, half), SAMPLE_RATE);
    const framesB = streamerHalved.push(pcm.slice(half), SAMPLE_RATE);
    const framesHalved = new Float32Array(framesA.length + framesB.length);
    framesHalved.set(framesA, 0);
    framesHalved.set(framesB, framesA.length);

    expect(framesHalved.length).toBe(framesFull.length);
    for (let i = 0; i < framesFull.length; i++) {
      expect(framesHalved[i]).toBe(framesFull[i]);
    }
  });

  test('empty push returns empty array', () => {
    const streamer = new RmsStreamer({ hopMs: HOP_MS });
    const result = streamer.push(new Float32Array(0), SAMPLE_RATE);
    expect(result.length).toBe(0);
  });

  test('push shorter than one hop returns empty array', () => {
    const hopSamples = Math.round((SAMPLE_RATE * HOP_MS) / 1000); // 320
    const streamer = new RmsStreamer({ hopMs: HOP_MS });
    const result = streamer.push(new Float32Array(hopSamples - 1), SAMPLE_RATE);
    expect(result.length).toBe(0);
  });

  test('flush with residual returns one frame', () => {
    const hopSamples = Math.round((SAMPLE_RATE * HOP_MS) / 1000); // 320
    const streamer = new RmsStreamer({ hopMs: HOP_MS });
    // Push exactly one hop so next samples accumulate as residual
    const pcm = new Float32Array(hopSamples + 10).fill(0.5);
    streamer.push(pcm, SAMPLE_RATE);
    const flushed = streamer.flush();
    expect(flushed.length).toBe(1);
    // RMS of 10 samples all 0.5 = 0.5
    expect(flushed[0]).toBeCloseTo(0.5, 9);
  });

  test('flush without residual returns empty array', () => {
    const hopSamples = Math.round((SAMPLE_RATE * HOP_MS) / 1000);
    const streamer = new RmsStreamer({ hopMs: HOP_MS });
    // Push exact multiple of hop so residual is zero
    const pcm = new Float32Array(hopSamples * 3).fill(0.3);
    streamer.push(pcm, SAMPLE_RATE);
    const flushed = streamer.flush();
    expect(flushed.length).toBe(0);
  });

  test('RMS value of a constant signal equals that constant', () => {
    const hopSamples = Math.round((SAMPLE_RATE * HOP_MS) / 1000);
    const streamer = new RmsStreamer({ hopMs: HOP_MS });
    const value = 0.7;
    const frames = streamer.push(new Float32Array(hopSamples * 4).fill(value), SAMPLE_RATE);
    expect(frames.length).toBe(4);
    for (const f of frames) {
      // Float32Array stores 0.7 with ~1e-7 error; use precision 6
      expect(f).toBeCloseTo(value, 6);
    }
  });
});
