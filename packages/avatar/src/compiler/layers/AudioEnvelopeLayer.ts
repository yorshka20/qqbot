import type { BotState } from '../../state/types';
import { BaseLayer } from './BaseLayer';

export interface AudioEnvelopeLayerOptions {
  /** Layer id; typically 'audio-envelope-<utteranceId>'. */
  id: string;
  /** Per-hop RMS envelope, from computeRmsEnvelope. */
  envelope: Float32Array;
  /** Must match the hopMs used to compute `envelope`. */
  hopMs: number;
  /** Wall-clock ms when playback begins (same basis as nowMs in sample()). */
  startAtMs: number;
  /** Wall-clock playback duration. sample() returns {} outside [startAt, startAt+duration]. */
  durationMs: number;
  /** Optional initial BaseLayer weight; default 1.0. */
  weight?: number;
}

/**
 * Ephemeral per-utterance layer that drives the `mouth.open` channel from a
 * pre-computed RMS envelope. Registered by SpeechService when synthesis
 * completes, unregistered on utterance end. NOT part of DEFAULT_LAYERS.
 */
export class AudioEnvelopeLayer extends BaseLayer {
  readonly id: string;
  private readonly envelope: Float32Array;
  private readonly hopMs: number;
  private readonly startAtMs: number;
  private readonly durationMs: number;

  constructor(opts: AudioEnvelopeLayerOptions) {
    super();
    this.id = opts.id;
    this.envelope = opts.envelope;
    this.hopMs = opts.hopMs;
    this.startAtMs = opts.startAtMs;
    this.durationMs = opts.durationMs;
    if (opts.weight !== undefined) this.setWeight(opts.weight);
  }

  sample(nowMs: number, _state: BotState): Record<string, number> {
    void _state;
    const t = nowMs - this.startAtMs;
    if (t < 0 || t > this.durationMs) return {};
    if (this.envelope.length === 0) return {};
    const idxF = t / this.hopMs;
    const i0 = Math.floor(idxF);
    if (i0 >= this.envelope.length) return {};
    const i1 = Math.min(i0 + 1, this.envelope.length - 1);
    const frac = idxF - i0;
    const v = this.envelope[i0] * (1 - frac) + this.envelope[i1] * frac;
    return { 'mouth.open': v };
  }
}
