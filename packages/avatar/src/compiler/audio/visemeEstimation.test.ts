import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VISEME_CENTROIDS,
  estimateVisemes,
  type VisemeName,
  VisemeStreamer,
  type VisemeWeights,
} from './visemeEstimation';

const ALL_VISEMES: readonly VisemeName[] = ['aa', 'ih', 'ee', 'oh', 'ou'];

/** Generate a mono sine wave at a given frequency, normalized to ±amp. */
function sine(freqHz: number, durSec: number, sampleRate: number, amp = 0.5): Float32Array {
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  const twoPiF = 2 * Math.PI * freqHz;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((twoPiF * i) / sampleRate);
  return out;
}

/** Return the viseme name with the highest weight. */
function dominantViseme(w: VisemeWeights): VisemeName {
  let best: VisemeName = 'aa';
  let bestVal = -Infinity;
  for (const v of ALL_VISEMES) {
    if (w[v] > bestVal) {
      bestVal = w[v];
      best = v;
    }
  }
  return best;
}

describe('VisemeStreamer — silence gate', () => {
  test('pure silence emits frames with all-zero weights', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = new Float32Array(Math.round(sr * 0.1)); // 100ms of zeros
    const frames = streamer.push(pcm, sr);

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      for (const v of ALL_VISEMES) {
        expect(f.weights[v]).toBe(0);
      }
      expect(f.rms).toBe(0);
    }
  });

  test('very quiet noise below silenceFloor also gates to zero', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20, silenceFloor: 0.02 });
    // Tiny-amplitude sine below the floor
    const pcm = sine(1000, 0.1, sr, 0.005);
    const frames = streamer.push(pcm, sr);

    expect(frames.length).toBeGreaterThan(0);
    // Skip the first few hops (filter warm-up transient can dip RMS slightly
    // above amp due to filter response; steady-state is what the gate sees)
    for (let i = 2; i < frames.length; i++) {
      const w = frames[i].weights;
      for (const v of ALL_VISEMES) {
        expect(w[v]).toBe(0);
      }
    }
  });
});

describe('VisemeStreamer — voiced-frame weights', () => {
  test('weights sum to approximately 1 on voiced frames', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = sine(1000, 0.2, sr, 0.5);
    const frames = streamer.push(pcm, sr);

    // Skip warm-up hops; biquad state transient affects the first few frames
    for (let i = 3; i < frames.length; i++) {
      const w = frames[i].weights;
      const sum = w.aa + w.ih + w.ee + w.oh + w.ou;
      expect(sum).toBeGreaterThan(0.99);
      expect(sum).toBeLessThan(1.01);
    }
  });

  test('very low tone (200 Hz) → dominant viseme is oh or ou', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = sine(200, 0.3, sr, 0.5);
    const frames = streamer.push(pcm, sr);

    // Steady-state frames only (filter warm-up ~ 50ms)
    const steady = frames.slice(3);
    const dominants = steady.map((f) => dominantViseme(f.weights));
    // Majority should be a back vowel (oh or ou)
    const backCount = dominants.filter((d) => d === 'oh' || d === 'ou').length;
    expect(backCount).toBeGreaterThan(steady.length * 0.8);
  });

  test('very high tone (3000 Hz) → dominant viseme is ee or ih', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = sine(3000, 0.3, sr, 0.5);
    const frames = streamer.push(pcm, sr);

    const steady = frames.slice(3);
    const dominants = steady.map((f) => dominantViseme(f.weights));
    const frontCount = dominants.filter((d) => d === 'ee' || d === 'ih').length;
    expect(frontCount).toBeGreaterThan(steady.length * 0.8);
  });

  test('mid-range tone (1000 Hz) → dominant viseme is aa', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = sine(1000, 0.3, sr, 0.5);
    const frames = streamer.push(pcm, sr);

    const steady = frames.slice(3);
    const dominants = steady.map((f) => dominantViseme(f.weights));
    const aaCount = dominants.filter((d) => d === 'aa').length;
    expect(aaCount).toBeGreaterThan(steady.length * 0.6);
  });
});

describe('VisemeStreamer — hop stitching', () => {
  test('bit-exact frames regardless of how PCM is split across push() calls', () => {
    const sr = 32000;
    const hopMs = 20;
    const pcm = sine(1000, 0.15, sr, 0.5);

    const oneShot = new VisemeStreamer({ hopMs });
    const framesA = oneShot.push(pcm, sr);
    const tailA = oneShot.flush();
    if (tailA) framesA.push(tailA);

    const split = new VisemeStreamer({ hopMs });
    // Split at an arbitrary non-hop-aligned boundary
    const cut = 1337;
    const framesB = [...split.push(pcm.subarray(0, cut), sr), ...split.push(pcm.subarray(cut), sr)];
    const tailB = split.flush();
    if (tailB) framesB.push(tailB);

    expect(framesB.length).toBe(framesA.length);
    for (let i = 0; i < framesA.length; i++) {
      for (const v of ALL_VISEMES) {
        expect(framesB[i].weights[v]).toBeCloseTo(framesA[i].weights[v], 8);
      }
      expect(framesB[i].rms).toBeCloseTo(framesA[i].rms, 8);
    }
  });

  test('partial hop buffered as residual; flushed by flush()', () => {
    const sr = 32000;
    const hopMs = 20;
    const hopSamples = (sr * hopMs) / 1000; // = 640
    const streamer = new VisemeStreamer({ hopMs });

    // Push 1.5 hops worth of samples
    const pcm = sine(1000, (hopMs * 1.5) / 1000, sr, 0.5);
    const frames = streamer.push(pcm, sr);
    expect(frames.length).toBe(1); // one full hop; residual holds 0.5 hop
    expect(pcm.length).toBe(Math.round(hopSamples * 1.5));

    const tail = streamer.flush();
    expect(tail).not.toBeNull();

    const tail2 = streamer.flush();
    expect(tail2).toBeNull();
  });
});

describe('VisemeStreamer — validation', () => {
  test('throws on hopMs <= 0', () => {
    expect(() => new VisemeStreamer({ hopMs: 0 })).toThrow(/hopMs/);
    expect(() => new VisemeStreamer({ hopMs: -20 })).toThrow(/hopMs/);
    expect(() => new VisemeStreamer({ hopMs: Number.NaN })).toThrow(/hopMs/);
  });

  test('throws if sample rate changes mid-stream', () => {
    const streamer = new VisemeStreamer({ hopMs: 20 });
    streamer.push(new Float32Array(320), 16000);
    expect(() => streamer.push(new Float32Array(320), 32000)).toThrow(/sampleRate/);
  });

  test('throws on non-positive sampleRate in push()', () => {
    const streamer = new VisemeStreamer({ hopMs: 20 });
    expect(() => streamer.push(new Float32Array(100), 0)).toThrow(/sampleRate/);
    expect(() => streamer.push(new Float32Array(100), -1)).toThrow(/sampleRate/);
  });

  test('reset() allows re-initializing at a different sample rate', () => {
    const streamer = new VisemeStreamer({ hopMs: 20 });
    streamer.push(new Float32Array(320), 16000);
    streamer.reset();
    // After reset, sampleRate lock is intentionally NOT reset (filters still
    // use 16k coefficients). This test documents that contract — callers
    // that want to change SR must construct a new streamer.
    expect(() => streamer.push(new Float32Array(320), 32000)).toThrow(/sampleRate/);
  });
});

describe('estimateVisemes (one-shot)', () => {
  test('equivalent to VisemeStreamer.push + flush', () => {
    const sr = 32000;
    const hopMs = 20;
    const pcm = sine(1000, 0.1, sr, 0.5);

    const framesA = estimateVisemes(pcm, sr, { hopMs });

    const streamer = new VisemeStreamer({ hopMs });
    const framesB = streamer.push(pcm, sr);
    const tail = streamer.flush();
    if (tail) framesB.push(tail);

    expect(framesA.length).toBe(framesB.length);
    for (let i = 0; i < framesA.length; i++) {
      for (const v of ALL_VISEMES) {
        expect(framesA[i].weights[v]).toBeCloseTo(framesB[i].weights[v], 10);
      }
    }
  });
});

describe('DEFAULT_VISEME_CENTROIDS', () => {
  test('exports all 5 canonical viseme names', () => {
    expect(Object.keys(DEFAULT_VISEME_CENTROIDS).sort()).toEqual(['aa', 'ee', 'ih', 'oh', 'ou']);
  });

  test('centroids are ordered: oh < ou < aa < ih < ee along the h axis', () => {
    const { oh, ou, aa, ih, ee } = DEFAULT_VISEME_CENTROIDS;
    expect(oh).toBeLessThan(ou);
    expect(ou).toBeLessThan(aa);
    expect(aa).toBeLessThan(ih);
    expect(ih).toBeLessThan(ee);
  });

  test('centroids span a reasonable portion of [0, 1]', () => {
    const values = Object.values(DEFAULT_VISEME_CENTROIDS);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(min).toBeGreaterThan(0.05);
    expect(max).toBeLessThan(0.95);
    expect(max - min).toBeGreaterThan(0.4); // real spread, not all bunched
  });
});

describe('centroid override', () => {
  test('custom centroids change the dominant viseme mapping', () => {
    const sr = 32000;

    // Default: 200 Hz → low h → dominant in { oh, ou }
    const defaultStreamer = new VisemeStreamer({ hopMs: 20 });
    const defaultFrames = defaultStreamer.push(sine(200, 0.2, sr, 0.5), sr).slice(3);
    const defaultDominant = dominantViseme(defaultFrames[0].weights);
    expect(defaultDominant === 'oh' || defaultDominant === 'ou').toBe(true);

    // Override: move "ee" centroid to h=0.05 (very low). 200 Hz now hits ee.
    const customStreamer = new VisemeStreamer({
      hopMs: 20,
      centroids: { ee: 0.05 },
    });
    const customFrames = customStreamer.push(sine(200, 0.2, sr, 0.5), sr).slice(3);
    const customDominant = dominantViseme(customFrames[0].weights);
    expect(customDominant).toBe('ee');
  });
});
