import type { AvatarActivity } from '../../state/types';
import { getAudioEnvelopeConfig } from './audio-envelope-config';
import { BaseLayer } from './BaseLayer';

export interface AudioEnvelopeLayerOptions {
  /** Layer id; typically 'audio-envelope-<utteranceId>'. */
  id: string;
  /**
   * Per-hop RMS envelope, from computeRmsEnvelope.
   * Omit to create the layer in streaming mode — call appendFrames() and
   * finalize() as audio arrives.
   */
  envelope?: Float32Array;
  /** Must match the hopMs used to compute `envelope`. */
  hopMs: number;
  /** Wall-clock ms when playback begins (same basis as nowMs in sample()). */
  startAtMs: number;
  /**
   * Wall-clock playback duration. sample() returns {} outside [startAt, startAt+duration].
   * In streaming mode this is set by finalize(); pass 0 (or any placeholder) here.
   */
  durationMs: number;
  /** Optional initial BaseLayer weight; default 1.0. */
  weight?: number;
}

const INITIAL_STREAMING_CAPACITY = 64;

/**
 * Target amplitude after streaming peak-normalization. Mirrors the 0.95 used
 * by `computeRmsEnvelope({ normalize: true })` so streaming and buffered
 * paths produce mouth openings of roughly the same maximum visual size.
 */
const STREAMING_NORMALIZE_TARGET = 0.95;

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
 *
 * **Streaming mode**: Construct without `envelope`. Call `appendFrames()` as
 * RMS frames arrive and `finalize(totalDurationMs)` when synthesis is done.
 * Streaming frames are stored raw (unnormalized) and divided by the running
 * per-utterance peak at `sample()` time, matching the 0.95 peak that the
 * buffered path gets from `computeRmsEnvelope({ normalize: true })`. This is
 * retroactive: as the peak grows mid-utterance, previously-sampled frames are
 * re-evaluated against the new peak. Because `sample()` is only called for
 * monotonically increasing `nowMs`, there's no visual glitch — the viewer
 * never re-sees an old frame.
 */
export class AudioEnvelopeLayer extends BaseLayer {
  readonly id: string;
  private envelopeData: Float32Array;
  /** Number of valid frames written (≤ envelopeData.length). */
  private envelopeLength: number;
  private readonly hopMs: number;
  private readonly startAtMs: number;
  private durationMs: number;
  /** True when constructed without a pre-computed envelope. Guards appendFrames/finalize. */
  private readonly streamingMode: boolean;
  /**
   * Running maximum of all RMS frames appended so far. Used by `sample()` in
   * streaming mode to normalize the output to `STREAMING_NORMALIZE_TARGET`.
   * Monotonically non-decreasing — never resets within an utterance.
   */
  private streamingPeak = 0;

  constructor(opts: AudioEnvelopeLayerOptions) {
    super();
    this.id = opts.id;
    this.hopMs = opts.hopMs;
    this.startAtMs = opts.startAtMs;
    this.durationMs = opts.durationMs;
    if (opts.weight !== undefined) this.setWeight(opts.weight);

    if (opts.envelope !== undefined) {
      this.envelopeData = opts.envelope;
      this.envelopeLength = opts.envelope.length;
      this.streamingMode = false;
    } else {
      this.envelopeData = new Float32Array(INITIAL_STREAMING_CAPACITY);
      this.envelopeLength = 0;
      this.streamingMode = true;
    }
  }

  /**
   * Append RMS frames (streaming mode only). Grows internal buffer with
   * geometric doubling to avoid O(n²) allocations.
   */
  appendFrames(frames: Float32Array | number[]): void {
    if (!this.streamingMode) {
      throw new Error('appendFrames called on non-streaming AudioEnvelopeLayer');
    }
    const arr = frames instanceof Float32Array ? frames : new Float32Array(frames);
    const needed = this.envelopeLength + arr.length;

    if (needed > this.envelopeData.length) {
      let newCapacity = this.envelopeData.length;
      while (newCapacity < needed) newCapacity *= 2;
      const grown = new Float32Array(newCapacity);
      grown.set(this.envelopeData.subarray(0, this.envelopeLength));
      this.envelopeData = grown;
    }

    this.envelopeData.set(arr, this.envelopeLength);
    this.envelopeLength += arr.length;

    // Track the running peak so sample() can normalize. Only the max matters;
    // NaN/negative guards are unnecessary because RMS is non-negative.
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      if (f > this.streamingPeak) this.streamingPeak = f;
    }
  }

  /**
   * Mark the streaming layer as complete. Sets the exact playback duration
   * so sample() uses the same boundary semantics as a fully-computed envelope.
   */
  finalize(totalDurationMs: number): void {
    this.durationMs = totalDurationMs;
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    const cfg = getAudioEnvelopeConfig();
    const t = nowMs - this.startAtMs;
    if (t < 0 || t > this.durationMs) return {};
    if (this.envelopeLength === 0) return {};

    const idxF = t / this.hopMs;
    const i0 = Math.floor(idxF);

    // Bound against logical length, not capacity
    if (i0 >= this.envelopeLength) {
      // In streaming mode: if not yet finalized or t is within the expected
      // duration, return {} (frames not yet arrived) rather than repeating
      // the last frame.
      return {};
    }

    const i1 = Math.min(i0 + 1, this.envelopeLength - 1);
    const frac = idxF - i0;
    const rawV = this.envelopeData[i0] * (1 - frac) + this.envelopeData[i1] * frac;

    // Streaming-mode peak normalization. Buffered mode (pre-computed envelope)
    // arrives already peak-normalized via computeRmsEnvelope({normalize:true}),
    // so we only rescale when we own the normalization — otherwise we'd
    // double-normalize.
    let v = rawV;
    if (this.streamingMode && this.streamingPeak > 0) {
      v = Math.min(1, (rawV / this.streamingPeak) * STREAMING_NORMALIZE_TARGET);
    }

    const out: Record<string, number> = { 'mouth.open': v };

    const excite = v <= cfg.threshold ? 0 : ((v - cfg.threshold) / (1 - cfg.threshold)) ** cfg.power;

    if (excite > 0) {
      out['body.z'] = cfg.bodyZMax * excite;
      out['eye.open.left'] = cfg.eyeOpenMax * excite;
      out['eye.open.right'] = cfg.eyeOpenMax * excite;
      out.brow = cfg.browMax * excite;
    }

    return out;
  }
}
