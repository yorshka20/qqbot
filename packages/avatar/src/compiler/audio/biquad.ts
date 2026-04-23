/**
 * Minimal Direct-Form-I biquad IIR filter. Hot-path primitive for time-domain
 * band-energy extraction — one 5-multiply, 4-add inner step per sample.
 *
 * Kept standalone (not inlined into callers) so it can be:
 *   - composed (stack a low-band and a high-band biquad in a single sample
 *     loop, see VisemeStreamer),
 *   - unit-tested against analytical responses (white noise through a
 *     known-Q bandpass should integrate to a predictable energy ratio),
 *   - reset independently of the enclosing streamer (important when the
 *     containing object wants to reuse itself across utterances).
 *
 * Why not WebAudio BiquadFilterNode: this module is consumed offline (from
 * Float32 PCM buffers) in bot-side SpeechService workers where no
 * AudioContext exists. WebAudio's node graph is also overkill for a single
 * 2nd-order stage.
 */

export interface BiquadCoeffs {
  /** Numerator (zero) coefficients. */
  b0: number;
  b1: number;
  b2: number;
  /**
   * Denominator (pole) coefficients. a0 is always 1 (coefficients are
   * pre-normalized by the designer); that's why we only store a1 / a2.
   */
  a1: number;
  a2: number;
}

/**
 * Design a constant-skirt-gain bandpass biquad (RBJ audio-eq cookbook,
 * "BPF, constant 0 dB peak gain"). Equivalent to:
 *
 *   H(s) = (s/Q) / (s² + s/Q + 1)
 *
 * Bandwidth at the -3 dB skirts is approximately centerHz / Q. A Q of 1.4
 * is a good starting point for formant-band extraction (~70% bandwidth).
 *
 * Throws on non-finite / non-positive inputs — silent NaN propagation from
 * a bad filter is notoriously hard to debug once the biquad is wrapped
 * inside a streamer.
 */
export function designBandpass(centerHz: number, q: number, sampleRate: number): BiquadCoeffs {
  if (!Number.isFinite(centerHz) || centerHz <= 0) {
    throw new Error(`designBandpass: centerHz must be > 0, got ${centerHz}`);
  }
  if (!Number.isFinite(q) || q <= 0) {
    throw new Error(`designBandpass: q must be > 0, got ${q}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`designBandpass: sampleRate must be > 0, got ${sampleRate}`);
  }

  // Nyquist guard: biquads become unstable as centerHz approaches sr/2.
  // Clamp a hair below Nyquist so callers don't need to.
  const safeCenter = Math.min(centerHz, sampleRate * 0.49);

  const w0 = (2 * Math.PI * safeCenter) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b1 = 0;
  const b2 = -alpha / a0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;

  return { b0, b1, b2, a1, a2 };
}

/**
 * Stateful biquad filter processor. Call `step(x)` per sample in a tight
 * loop; keeps 4 floats of state across calls. Reset clears the state so
 * the same filter can be reused across unrelated audio segments without
 * "ghost" energy from the previous segment's tail leaking in.
 */
export class Biquad {
  private readonly coeffs: BiquadCoeffs;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(coeffs: BiquadCoeffs) {
    this.coeffs = coeffs;
  }

  /** Process one input sample; return the filtered output. */
  step(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.coeffs;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  /** Zero out the internal state. Call when reusing across unrelated audio. */
  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}
