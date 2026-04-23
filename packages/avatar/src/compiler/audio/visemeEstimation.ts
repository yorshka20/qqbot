/**
 * Streaming viseme estimation — maps mono Float32 PCM to per-hop weights
 * for the 5 AEIUO visemes used by VRM preset expressions (`aa / ih / ee /
 * oh / ou`).
 *
 * ## Algorithm
 *
 * We project each hop into a 2D formant plane:
 *
 *   L = energy of a bandpass centered near F1 (~500 Hz, Q≈1.4)
 *   H = energy of a bandpass centered near F2 (~2000 Hz, Q≈1.4)
 *
 * Then normalize `(l, h) = (L, H) / (L+H+ε)` so both are loudness-invariant
 * and `l + h = 1`. Each viseme has a canonical `h` coordinate (the
 * high-band fraction) calibrated roughly from published AEIUO formant
 * frequencies. Scoring is a 1D Gaussian against `h`; softmax normalizes
 * the 5 scores to weights.
 *
 * The weights sum to 1 on voiced frames (before amplitude gating) and to
 * 0 on silent frames (RMS below the silence floor). Callers typically
 * multiply `weights[v]` by a desired mouth opening (RMS-driven or
 * otherwise) to get the final blendshape value.
 *
 * ## Why 2 biquads instead of 5
 *
 * A 5-biquad approach (one per viseme, each centered on that vowel's
 * "most characteristic" frequency) drags in messy cross-talk: `/o/` and
 * `/u/` are both low-formant, so centers at 600 Hz and 450 Hz respond
 * almost identically to voicing and discriminating them requires
 * ad-hoc subtraction tricks. The F1/F2 2D approach encodes "back vs
 * front / closed vs open" as a 1D ratio, which cleanly separates all
 * five canonical vowels with soft overlap — no subtraction, no center
 * frequency arithmetic.
 *
 * ## Integration contract
 *
 * Output is intentionally decoupled from:
 *   - `RmsStreamer` (we return our own RMS inline; callers that only
 *     need visemes don't need a separate streamer),
 *   - any `AudioEnvelopeLayer` / `SpeechService` glue (integration is a
 *     separate ticket; this file is a pure DSP module).
 *
 * The one coupling we accept: the viseme name strings (`aa / ih / ee /
 * oh / ou`) match both the VRM preset spec and the bot-side
 * `CANONICAL_EXPRESSIONS` vocabulary, so downstream channels
 * `mouth.viseme.<name>` can map 1:1 without renaming.
 */

import { Biquad, designBandpass } from './biquad';

export type VisemeName = 'aa' | 'ih' | 'ee' | 'oh' | 'ou';

export interface VisemeWeights {
  aa: number;
  ih: number;
  ee: number;
  oh: number;
  ou: number;
}

export interface VisemeFrame {
  /** Per-viseme weights. Sum ≈ 1 when voiced, all 0 when silent-gated. */
  weights: VisemeWeights;
  /**
   * RMS of this hop's samples (linear, not dB). Computed inline with the
   * filter loop so callers don't need to run `RmsStreamer` in parallel.
   * Unnormalized (raw amplitude); apply your own peak-follower if you
   * want loudness-normalized mouth opening.
   */
  rms: number;
}

export interface VisemeStreamerOptions {
  /**
   * Hop duration in ms. One `VisemeFrame` is emitted per hop. Typical
   * value: 20 ms (matches the bot-side `ENVELOPE_HOP_MS`).
   */
  hopMs: number;
  /**
   * Silence-gate RMS threshold. Hops below this emit weights=all-zero so
   * pauses actively close the mouth rather than holding the last voiced
   * viseme. Default 0.01 which is a hair above typical mic noise floor
   * on normalized float PCM.
   */
  silenceFloor?: number;
  /**
   * Softmax temperature for the `h` scoring. Smaller = sharper (more
   * winner-take-all), larger = softer blend between neighbouring visemes.
   * Default 0.12 — produces ~70/20/10 distribution for a clean vowel.
   */
  temperature?: number;
  /**
   * Low-band and high-band center frequencies (Hz) and shared Q factor.
   * Exposed for tuning per-language (Mandarin formants differ slightly
   * from the canonical English values baked into the defaults). Do NOT
   * override blindly — default centers are calibrated against the
   * viseme centroids below.
   */
  lowCenterHz?: number;
  highCenterHz?: number;
  q?: number;
  /**
   * Per-viseme canonical `h` (high-band energy fraction). Override only
   * if you've measured your TTS's actual formant distribution; the
   * defaults are tuned for generic voiced speech and match the Sovits
   * output sampled during development.
   */
  centroids?: Partial<Record<VisemeName, number>>;
}

/**
 * Default viseme centroids in the `h = E_high / (E_high + E_low)` axis.
 *
 * Derivation: for each vowel we take its canonical F1 / F2 from published
 * tables, pass two sine waves at (F1, F2) through the default biquad
 * pair, and record the steady-state (l, h) ratio. These are the rounded
 * results — tune per-language via `opts.centroids` if needed.
 *
 * Ordering (low h → high h): oh, ou, aa, ih, ee. The 1D spread in h
 * alone suffices to discriminate all 5 with soft overlap, which is why
 * this module only needs TWO biquads, not five.
 */
export const DEFAULT_VISEME_CENTROIDS: Record<VisemeName, number> = {
  oh: 0.18,
  ou: 0.25,
  aa: 0.45,
  ih: 0.7,
  ee: 0.82,
};

const ALL_VISEMES: readonly VisemeName[] = ['aa', 'ih', 'ee', 'oh', 'ou'] as const;

const ZERO_WEIGHTS: VisemeWeights = Object.freeze({ aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 });

/**
 * Resolve options against defaults. Kept as a standalone helper so the
 * same resolution runs for both the streaming class and any future
 * one-shot function that shares this module's conventions.
 */
interface ResolvedOptions {
  hopMs: number;
  silenceFloor: number;
  temperature: number;
  lowCenterHz: number;
  highCenterHz: number;
  q: number;
  centroids: Record<VisemeName, number>;
}

function resolveOptions(opts: VisemeStreamerOptions): ResolvedOptions {
  if (!Number.isFinite(opts.hopMs) || opts.hopMs <= 0) {
    throw new Error(`VisemeStreamer: hopMs must be > 0, got ${opts.hopMs}`);
  }
  const centroids: Record<VisemeName, number> = { ...DEFAULT_VISEME_CENTROIDS };
  if (opts.centroids) {
    for (const v of ALL_VISEMES) {
      const override = opts.centroids[v];
      if (typeof override === 'number' && Number.isFinite(override)) {
        centroids[v] = override;
      }
    }
  }
  return {
    hopMs: opts.hopMs,
    silenceFloor: opts.silenceFloor ?? 0.01,
    temperature: opts.temperature ?? 0.12,
    lowCenterHz: opts.lowCenterHz ?? 500,
    highCenterHz: opts.highCenterHz ?? 2000,
    q: opts.q ?? 1.4,
    centroids,
  };
}

/**
 * Incremental viseme weight extractor. Feed Float32 mono PCM chunks via
 * `push()`; receive zero or more completed `VisemeFrame`s per call. The
 * first push locks in the sample rate (biquad coefficients are designed
 * lazily so callers don't need to know SR at construction); subsequent
 * pushes with a mismatched SR throw to prevent silent mis-tuning.
 *
 * Residual samples that don't fill a hop are buffered internally and
 * concatenated with the next push — hop boundaries are preserved
 * bit-exactly across chunk boundaries.
 */
export class VisemeStreamer {
  private readonly opts: ResolvedOptions;
  private sampleRate = 0;
  private lowBand: Biquad | null = null;
  private highBand: Biquad | null = null;
  private residual: Float32Array = new Float32Array(0);

  constructor(opts: VisemeStreamerOptions) {
    this.opts = resolveOptions(opts);
  }

  /**
   * Process a chunk of PCM; return completed frames for hop boundaries
   * fully contained in this call.
   */
  push(pcm: Float32Array, sampleRate: number): VisemeFrame[] {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`VisemeStreamer.push: sampleRate must be > 0, got ${sampleRate}`);
    }

    if (this.sampleRate === 0) {
      this.sampleRate = sampleRate;
      this.lowBand = new Biquad(designBandpass(this.opts.lowCenterHz, this.opts.q, sampleRate));
      this.highBand = new Biquad(designBandpass(this.opts.highCenterHz, this.opts.q, sampleRate));
    } else if (sampleRate !== this.sampleRate) {
      throw new Error(
        `VisemeStreamer.push: sampleRate changed mid-stream (${this.sampleRate} → ${sampleRate}); call reset() first`,
      );
    }

    const hopSamples = Math.max(1, Math.round((sampleRate * this.opts.hopMs) / 1000));

    // Residual + chunk concat is unavoidable because hops cross chunk
    // boundaries in streaming TTS; the filter state is preserved across
    // this concatenation automatically (it lives on the Biquad object,
    // not the buffer).
    const total = new Float32Array(this.residual.length + pcm.length);
    total.set(this.residual, 0);
    total.set(pcm, this.residual.length);

    const numHops = Math.floor(total.length / hopSamples);
    const frames: VisemeFrame[] = new Array(numHops);

    for (let i = 0; i < numHops; i++) {
      frames[i] = this.computeFrame(total, i * hopSamples, hopSamples);
    }

    this.residual = total.slice(numHops * hopSamples);
    return frames;
  }

  /**
   * Flush the remaining residual as a single trailing frame. Returns null
   * if no residual (e.g. when the last push lined up on a hop boundary).
   *
   * Useful at end-of-utterance to avoid dropping the final < 20 ms of
   * audio. Note the returned frame may be computed over fewer samples
   * than a normal hop, so its RMS is slightly less statistically stable
   * — but viseme weights are ratio-based and survive this fine.
   */
  flush(): VisemeFrame | null {
    if (this.residual.length === 0) return null;
    const frame = this.computeFrame(this.residual, 0, this.residual.length);
    this.residual = new Float32Array(0);
    return frame;
  }

  /**
   * Clear filter state and residual. Call between unrelated audio
   * segments (e.g. utterance boundaries when reusing the streamer) to
   * prevent the previous segment's filter tail from leaking into the
   * next segment's first hop.
   */
  reset(): void {
    this.lowBand?.reset();
    this.highBand?.reset();
    this.residual = new Float32Array(0);
  }

  /**
   * Process `len` samples starting at `start` into one VisemeFrame.
   * Combines the biquad sample loop with inline RMS accumulation so the
   * caller doesn't pay for two passes over the same samples.
   */
  private computeFrame(buf: Float32Array, start: number, len: number): VisemeFrame {
    const low = this.lowBand;
    const high = this.highBand;
    // Unreachable at runtime (push() initializes both before calling us)
    // but narrow the types for TS.
    if (!low || !high) {
      return { weights: ZERO_WEIGHTS, rms: 0 };
    }

    let sumSqLow = 0;
    let sumSqHigh = 0;
    let sumSq = 0;

    for (let i = 0; i < len; i++) {
      const x = buf[start + i];
      const yl = low.step(x);
      const yh = high.step(x);
      sumSqLow += yl * yl;
      sumSqHigh += yh * yh;
      sumSq += x * x;
    }

    const rms = Math.sqrt(sumSq / len);

    if (rms < this.opts.silenceFloor) {
      return { weights: { ...ZERO_WEIGHTS }, rms };
    }

    // Loudness-invariant h in [0, 1]. The denominator epsilon guards the
    // transient boot-up hop where both filters haven't settled — without
    // it, a ratio of 0/~0 can swing wildly and produce garbage visemes
    // on the very first frame of an utterance.
    const eTotal = sumSqLow + sumSqHigh;
    const h = eTotal > 1e-12 ? sumSqHigh / eTotal : 0.5;

    const weights = this.scoreVisemes(h);
    return { weights, rms };
  }

  /**
   * Gaussian score each viseme by its distance to the observed `h`; then
   * softmax-normalize so the weights sum to 1. Temperature controls the
   * sharpness: small values collapse to the nearest single viseme, large
   * values spread weight across all 5 (looks mushy, "all visemes on at
   * 0.2 each").
   */
  private scoreVisemes(h: number): VisemeWeights {
    const { temperature, centroids } = this.opts;
    const invT2 = 1 / (temperature * temperature);

    // Compute unnormalized scores. Subtract the max before exp for
    // numerical stability (standard softmax trick) — otherwise tight
    // centroids near h can overflow exp() into Infinity for very small
    // temperatures.
    let maxLogit = Number.NEGATIVE_INFINITY;
    const logits: Record<VisemeName, number> = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 };
    for (const v of ALL_VISEMES) {
      const d = h - centroids[v];
      const logit = -(d * d) * invT2;
      logits[v] = logit;
      if (logit > maxLogit) maxLogit = logit;
    }

    let sum = 0;
    const exps: Record<VisemeName, number> = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 };
    for (const v of ALL_VISEMES) {
      const e = Math.exp(logits[v] - maxLogit);
      exps[v] = e;
      sum += e;
    }

    const weights: VisemeWeights = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 };
    if (sum > 0) {
      for (const v of ALL_VISEMES) {
        weights[v] = exps[v] / sum;
      }
    }
    return weights;
  }
}

/**
 * Convenience one-shot estimator for a complete PCM buffer. Equivalent
 * to constructing a `VisemeStreamer`, pushing once, and flushing —
 * useful for tests and offline analysis. Do NOT use in the streaming
 * TTS path; that's what `VisemeStreamer` is for.
 */
export function estimateVisemes(pcm: Float32Array, sampleRate: number, opts: VisemeStreamerOptions): VisemeFrame[] {
  const streamer = new VisemeStreamer(opts);
  const frames = streamer.push(pcm, sampleRate);
  const tail = streamer.flush();
  if (tail) frames.push(tail);
  return frames;
}
