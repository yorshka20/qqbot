import type { TunableParam } from '../../preview/types';
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
  /**
   * EMA coefficient applied to incoming RMS. `smoothed = smoothed + (rms - smoothed) * α`.
   * Tuned so per-beat transients (snare hits, kicks) don't jitter body.z while
   * the overall music envelope still gets through.
   * Default 0.15 at 30Hz → τ≈200ms (63% response at 200ms, 95% at 600ms).
   * Set to 1 to disable smoothing; smaller values = slower response.
   */
  smoothingAlpha?: number;
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
  smoothingAlpha: 0.15,
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
  // AmbientAudioLayer drives generic body channels available in both cubism and vrm.
  readonly modelSupport = ['cubism', 'vrm'] as const;
  private readonly opts: Required<AmbientAudioLayerOptions>;
  private lastRms = 0;
  private lastSeenMs = 0;

  constructor(opts: AmbientAudioLayerOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Called by the PreviewServer → AvatarService bridge each time WS emits. */
  updateRms(rms: number, tMsFromRenderer: number): void {
    // Apply EMA so per-beat transients don't cause body.z to snap.
    // `lastRms` represents the temporally-smoothed value, not the raw input.
    // Staleness check uses wall-clock `Date.now()` since renderer clock may drift.
    this.lastRms = this.lastRms + (rms - this.lastRms) * this.opts.smoothingAlpha;
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

  getTunableParams(): TunableParam[] {
    return [
      {
        id: 'silenceFloor',
        label: 'Silence Floor',
        min: 0,
        max: 0.2,
        step: 0.005,
        value: this.opts.silenceFloor,
        default: 0.02,
      },
      {
        id: 'powerExponent',
        label: 'Power Exponent',
        min: 0.3,
        max: 3,
        step: 0.05,
        value: this.opts.powerExponent,
        default: 1,
      },
      { id: 'bodyZMax', label: 'body.z Max', min: 0, max: 3, step: 0.05, value: this.opts.bodyZMax, default: 0.8 },
      { id: 'browMax', label: 'brow Max', min: 0, max: 2, step: 0.05, value: this.opts.browMax, default: 0.5 },
      {
        id: 'smoothingAlpha',
        label: 'Smoothing α',
        min: 0.02,
        max: 1,
        step: 0.01,
        value: this.opts.smoothingAlpha,
        default: 0.15,
      },
    ];
  }

  setTunableParam(paramId: string, value: number): void {
    switch (paramId) {
      case 'silenceFloor':
        this.opts.silenceFloor = value;
        break;
      case 'powerExponent':
        this.opts.powerExponent = value;
        break;
      case 'bodyZMax':
        this.opts.bodyZMax = value;
        break;
      case 'browMax':
        this.opts.browMax = value;
        break;
      case 'smoothingAlpha':
        this.opts.smoothingAlpha = value;
        break;
      // unknown: silent drop
    }
  }

  override reset(): void {
    this.lastRms = 0;
    this.lastSeenMs = 0;
  }
}
