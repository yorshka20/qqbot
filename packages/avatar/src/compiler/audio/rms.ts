export interface RmsEnvelopeOptions {
  /** Hop (stride) between consecutive envelope samples in ms. Default 20. */
  hopMs?: number;
  /** Window size for each RMS computation in ms. Default 30. */
  windowMs?: number;
  /**
   * Peak-normalize the output so max value is 0.95. Default true.
   * Quiet fish.audio utterances have small RMS; without this the mouth barely moves.
   * If the computed peak is 0, the output stays all-zero (no divide-by-zero).
   */
  normalize?: boolean;
}

/**
 * Compute per-hop RMS envelope of mono Float32 PCM audio.
 *
 * Output length = floor(pcm.length / hopSamples). Each value is the RMS of the
 * window of `windowMs` centered on that hop. Window and hop differ (default
 * 30/20 ms = 10 ms overlap) to smooth consecutive samples.
 */
export function computeRmsEnvelope(pcm: Float32Array, sampleRate: number, opts?: RmsEnvelopeOptions): Float32Array {
  const hopMs = opts?.hopMs ?? 20;
  const windowMs = opts?.windowMs ?? 30;
  const normalize = opts?.normalize !== false; // default true

  const hopSamples = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const halfWin = Math.floor(windowSamples / 2);

  const outLen = Math.floor(pcm.length / hopSamples);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const center = i * hopSamples;
    const lo = Math.max(0, center - halfWin);
    const hi = Math.min(pcm.length, center + halfWin);
    let sumSq = 0;
    for (let j = lo; j < hi; j++) {
      const v = pcm[j];
      sumSq += v * v;
    }
    const n = hi - lo;
    out[i] = n > 0 ? Math.sqrt(sumSq / n) : 0;
  }

  if (normalize) {
    let peak = 0;
    for (let i = 0; i < outLen; i++) {
      if (out[i] > peak) peak = out[i];
    }
    if (peak > 0) {
      const scale = 0.95 / peak;
      for (let i = 0; i < outLen; i++) out[i] *= scale;
    }
    // If peak === 0, leave the all-zero array as-is. Do NOT divide.
  }

  return out;
}
