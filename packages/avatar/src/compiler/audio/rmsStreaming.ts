/**
 * Streaming RMS envelope computation.
 *
 * Unlike `computeRmsEnvelope` which operates on a complete PCM buffer,
 * `RmsStreamer` accepts PCM chunks incrementally and emits one RMS frame
 * per hop boundary. The output is bit-equal to a single one-shot computation
 * over the concatenated PCM, because each hop uses exactly `hopSamples`
 * samples with no overlap window.
 */
export class RmsStreamer {
  private readonly hopMs: number;
  /** Residual samples that didn't form a complete hop yet. */
  private residual: Float32Array = new Float32Array(0);

  constructor(opts: { hopMs: number }) {
    this.hopMs = opts.hopMs;
  }

  /**
   * Push a chunk of mono Float32 PCM. Returns the RMS frames completed by
   * this chunk (may be empty if the chunk is shorter than one hop).
   */
  push(pcm: Float32Array, sampleRate: number): Float32Array {
    const hopSamples = Math.max(1, Math.round((sampleRate * this.hopMs) / 1000));

    // Concatenate residual + new chunk
    const total = new Float32Array(this.residual.length + pcm.length);
    total.set(this.residual, 0);
    total.set(pcm, this.residual.length);

    const numHops = Math.floor(total.length / hopSamples);
    if (numHops === 0) {
      this.residual = total;
      return new Float32Array(0);
    }

    const frames = new Float32Array(numHops);
    for (let i = 0; i < numHops; i++) {
      const lo = i * hopSamples;
      const hi = lo + hopSamples;
      let sumSq = 0;
      for (let j = lo; j < hi; j++) {
        const v = total[j];
        sumSq += v * v;
      }
      frames[i] = Math.sqrt(sumSq / hopSamples);
    }

    // Keep leftover samples as next residual
    const consumed = numHops * hopSamples;
    this.residual = total.slice(consumed);

    return frames;
  }

  /**
   * Flush remaining residual samples as a single RMS frame.
   * Returns a Float32Array of length 1 if residual exists, else length 0.
   */
  flush(): Float32Array {
    if (this.residual.length === 0) return new Float32Array(0);

    let sumSq = 0;
    for (let i = 0; i < this.residual.length; i++) {
      const v = this.residual[i];
      sumSq += v * v;
    }
    const frame = Math.sqrt(sumSq / this.residual.length);
    this.residual = new Float32Array(0);
    return new Float32Array([frame]);
  }
}
