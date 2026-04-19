import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

/**
 * Soft-threshold below which audio energy contributes zero "excite" to
 * body/eye/brow. Avoids twitchy animation during quiet phonemes. RMS
 * envelope is peak-normalized so values live roughly in [0, 0.95];
 * 0.3 keeps unstressed syllables below the activation line.
 */
const EXCITE_THRESHOLD = 0.3;

/**
 * Power-law exponent applied to the above-threshold audio energy.
 * 2 = quadratic: layer is insensitive to mid-volume speech and clearly
 * reacts only when the speaker emphasizes / raises volume.
 */
const EXCITE_POWER = 2;

/** Max additive contribution to `body.z` (normalized forward-lean units). */
const BODY_Z_MAX = 0.4;

/** Max additive contribution to `eye.open.left` / `eye.open.right` ([0,1] units). */
const EYE_OPEN_MAX = 0.15;

/** Max additive contribution to `brow` ([-1, 1] units). */
const BROW_MAX = 0.3;

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
 * Ephemeral per-utterance layer driven by a pre-computed RMS envelope.
 *
 * Drives two families of channels:
 *   - `mouth.open` — linear pass-through of the interpolated RMS value.
 *     Linear because mouth shape must track every phoneme including
 *     quiet ones; a threshold here would mute soft speech.
 *   - `body.z`, `eye.open.left`, `eye.open.right`, `brow` — soft-threshold
 *     + power-law mapping of the same RMS value. Only emitted when the
 *     derived `excite` scalar is > 0, so quiet speech leaves those
 *     channels to baseline layers (AutoBlink, Breath) and action layers.
 *
 * Registered by SpeechService when synthesis completes, unregistered on
 * utterance end. NOT part of DEFAULT_LAYERS.
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

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    const t = nowMs - this.startAtMs;
    if (t < 0 || t > this.durationMs) return {};
    if (this.envelope.length === 0) return {};
    const idxF = t / this.hopMs;
    const i0 = Math.floor(idxF);
    if (i0 >= this.envelope.length) return {};
    const i1 = Math.min(i0 + 1, this.envelope.length - 1);
    const frac = idxF - i0;
    const v = this.envelope[i0] * (1 - frac) + this.envelope[i1] * frac;

    const out: Record<string, number> = { 'mouth.open': v };

    const excite = v <= EXCITE_THRESHOLD ? 0 : ((v - EXCITE_THRESHOLD) / (1 - EXCITE_THRESHOLD)) ** EXCITE_POWER;

    if (excite > 0) {
      out['body.z'] = BODY_Z_MAX * excite;
      out['eye.open.left'] = EYE_OPEN_MAX * excite;
      out['eye.open.right'] = EYE_OPEN_MAX * excite;
      out.brow = BROW_MAX * excite;
    }

    return out;
  }
}
