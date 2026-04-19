import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

export interface AmbientAudioLayerOptions {
  /** Max wall-clock gap since last update before layer fades out. Default 500ms. */
  staleThresholdMs?: number;
  /** Silence floor — RMS at or below this contributes 0. Default 0.02. */
  silenceFloor?: number;
  /** Power-law exponent applied to normalized excitement. Default 1 (linear). */
  powerExponent?: number;
  /** Max body.z contribution at full excitement. Default 0.8. */
  bodyZMax?: number;
  /** Max brow contribution at full excitement. Default 0.5. */
  browMax?: number;
}

// Tuned for Windows WASAPI loopback RMS of typical BGM (0.05–0.3 range).
// Original (silenceFloor=0.05, powerExp=2, body/brow 0.2/0.15) produced
// body.z ≈ 0.0006 at RMS 0.10 — imperceptible. Linear mapping with
// expanded max values gives a clear lean at moderate music volumes.
const DEFAULTS: Required<AmbientAudioLayerOptions> = {
  staleThresholdMs: 500,
  silenceFloor: 0.02,
  powerExponent: 1,
  bodyZMax: 0.8,
  browMax: 0.5,
};

/**
 * Long-lived ambient layer driven by renderer-reported system audio RMS.
 *
 * Data path: renderer PreviewServer WS → PreviewServer onAmbientAudio →
 * AvatarService → this.updateRms(). The layer stores latest (rms, tMs) and
 * samples from it every compiler tick.
 *
 * Differs from AudioEnvelopeLayer (ephemeral, per-utterance) in that this
 * is registered once into DEFAULT_LAYERS and never unregistered. No data
 * arriving → sample() returns {} (layer goes silent, downstream spring
 * damper fades body.z / brow back to 0).
 */
export class AmbientAudioLayer extends BaseLayer {
  readonly id = 'ambient-audio';
  private readonly opts: Required<AmbientAudioLayerOptions>;
  private lastRms = 0;
  private lastSeenMs = 0;

  constructor(opts: AmbientAudioLayerOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Called by the PreviewServer → AvatarService bridge each time WS emits. */
  updateRms(rms: number, tMsFromRenderer: number): void {
    // Store as-is; use wall-clock `Date.now()` for staleness check since
    // clocks may drift (renderer tMs is informational only).
    this.lastRms = rms;
    this.lastSeenMs = Date.now();
    void tMsFromRenderer; // reserved for future jitter tracking
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    // Stale guard: no data for a while → silent (compiler drops keys,
    // spring damper fades body/brow back to baseline).
    if (this.lastSeenMs === 0 || nowMs - this.lastSeenMs > this.opts.staleThresholdMs) {
      return {};
    }
    // Silence floor
    if (this.lastRms <= this.opts.silenceFloor) return {};

    // Normalize above floor to [0, 1], then power-law
    const normalized = Math.min(1, (this.lastRms - this.opts.silenceFloor) / (1 - this.opts.silenceFloor));
    const excite = normalized ** this.opts.powerExponent;
    if (excite === 0) return {};

    return {
      'body.z': this.opts.bodyZMax * excite,
      brow: this.opts.browMax * excite,
    };
  }

  override reset(): void {
    this.lastRms = 0;
    this.lastSeenMs = 0;
  }
}
