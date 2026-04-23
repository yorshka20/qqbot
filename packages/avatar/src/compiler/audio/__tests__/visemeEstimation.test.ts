import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VISEME_CENTROIDS,
  estimateVisemes,
  type VisemeName,
  VisemeStreamer,
  type VisemeWeights,
} from '../visemeEstimation';

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

describe('h exposure', () => {
  test('h is populated on every frame (voiced, silent, and early transient)', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    // Mix silence + voiced so we hit both branches of computeFrame.
    const silence = new Float32Array(Math.round(sr * 0.05));
    const tone = sine(1000, 0.1, sr, 0.5);
    const mixed = new Float32Array(silence.length + tone.length);
    mixed.set(silence, 0);
    mixed.set(tone, silence.length);
    const frames = streamer.push(mixed, sr);

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(typeof f.h).toBe('number');
      expect(Number.isFinite(f.h)).toBe(true);
      expect(f.h).toBeGreaterThanOrEqual(0);
      expect(f.h).toBeLessThanOrEqual(1);
    }
  });

  test('silent frames report h = 0.5 (epsilon guard) rather than NaN', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });
    const pcm = new Float32Array(Math.round(sr * 0.1));
    const frames = streamer.push(pcm, sr);

    for (const f of frames) {
      expect(f.rms).toBe(0);
      expect(f.h).toBe(0.5);
    }
  });
});

describe('pre-emphasis', () => {
  test('default (preEmphasis=true) raises h on low-frequency-dominated input', () => {
    // A 500 Hz tone should be ~half-attenuated by a first-order pre-emphasis
    // (α=0.97 gives a ~−6 dB/oct rolloff correction); the high band at 2000 Hz
    // is not touched. So h should be higher with pre-emphasis than without.
    const sr = 32000;
    const tone = sine(500, 0.2, sr, 0.5);

    const withPE = new VisemeStreamer({ hopMs: 20, preEmphasis: true }).push(tone, sr).slice(3); // skip filter warm-up
    const noPE = new VisemeStreamer({ hopMs: 20, preEmphasis: false }).push(tone, sr).slice(3);

    expect(withPE.length).toBeGreaterThan(0);
    expect(noPE.length).toBeGreaterThan(0);
    // Pre-emphasis attenuates the 500 Hz low-band energy relative to the
    // 2000 Hz high-band energy → h increases.
    expect(withPE[0].h).toBeGreaterThan(noPE[0].h);
  });

  test('preEmphasis=false preserves raw filter behaviour (regression for A/B)', () => {
    const sr = 32000;
    const tone = sine(1000, 0.2, sr, 0.5);
    const s1 = new VisemeStreamer({ hopMs: 20, preEmphasis: false }).push(tone, sr);
    const s2 = new VisemeStreamer({ hopMs: 20, preEmphasis: false }).push(tone, sr);

    // Same input + same (disabled) pre-emphasis must be bit-exact across runs.
    expect(s1.length).toBe(s2.length);
    for (let i = 0; i < s1.length; i++) {
      expect(s1[i].h).toBeCloseTo(s2[i].h, 10);
      expect(s1[i].rms).toBeCloseTo(s2[i].rms, 10);
    }
  });

  test('pre-emphasis state carries across push() calls (no seam artifact)', () => {
    // Split a single continuous tone in half. If the pre-emphasis memory were
    // reset between pushes, the first sample of the second chunk would be
    // treated as "x[n−1] = 0", creating a spurious high-frequency spike.
    const sr = 32000;
    const tone = sine(1000, 0.2, sr, 0.5);
    const half = Math.floor(tone.length / 2);
    const chunk1 = tone.subarray(0, half);
    const chunk2 = tone.subarray(half);

    const split = new VisemeStreamer({ hopMs: 20 });
    const a = split.push(chunk1, sr);
    const b = split.push(chunk2, sr);

    const whole = new VisemeStreamer({ hopMs: 20 }).push(tone, sr);

    // Frames on each side of the seam should match the single-push version
    // to within FP epsilon — this is the "no seam" guarantee that motivates
    // carrying preEmphPrev across pushes.
    const combined = [...a, ...b];
    expect(combined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(combined[i].h).toBeCloseTo(whole[i].h, 10);
      expect(combined[i].rms).toBeCloseTo(whole[i].rms, 10);
    }
  });

  test('reset() clears pre-emphasis state so stale samples do not bleed', () => {
    const sr = 32000;
    const streamer = new VisemeStreamer({ hopMs: 20 });

    // Push a loud signal to charge up pre-emphasis state.
    streamer.push(sine(1000, 0.2, sr, 0.8), sr);
    streamer.reset();

    // Fresh streamer processing silence — if reset failed, the first sample's
    // pre-emph output would be (0 − 0.97*lastLoudSample), producing a spike
    // that would register as noisy RMS on the first hop.
    const afterReset = streamer.push(new Float32Array(Math.round(sr * 0.1)), sr);
    for (const f of afterReset) {
      expect(f.rms).toBe(0);
    }
  });
});
