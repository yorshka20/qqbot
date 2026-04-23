import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function grad1d(hash: number, x: number): number {
  return (hash & 1) === 0 ? x : -x;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPermutation(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}

function perlin1d(p: Uint8Array, x: number): number {
  const xi = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  const u = fade(xf);
  const a = grad1d(p[xi], xf);
  const b = grad1d(p[xi + 1], xf - 1);
  return lerp(a, b, u) * 2;
}

/**
 * Maps a raw perlin sample (roughly [-1, 1]) through a two-threshold ramp
 * producing an envelope in [0, 1]:
 *
 * - raw ≤ pauseBelow  → 0  (fully paused, no motion on this channel)
 * - raw ≥ activeAbove → 1  (full amplitude)
 * - in between        → smoothstep fade
 *
 * Used to modulate each channel's amplitude so the layer has natural pauses
 * and amplitude variation instead of a constantly-moving output.
 */
function envelopeValue(raw: number, pauseBelow: number, activeAbove: number): number {
  if (activeAbove <= pauseBelow) return raw >= activeAbove ? 1 : 0;
  if (raw <= pauseBelow) return 0;
  if (raw >= activeAbove) return 1;
  const s = (raw - pauseBelow) / (activeAbove - pauseBelow);
  return s * s * (3 - 2 * s);
}

export interface PerlinChannelConfig {
  /** Peak amplitude for this channel (in channel's native units). */
  amplitude: number;
  /** Motion noise frequency (Hz). Higher = faster wiggle. */
  frequencyHz: number;
  /** Seed for the motion-noise permutation table. */
  seed: number;
  /**
   * Frequency (Hz) of the slow activity envelope that multiplies the raw
   * motion. Typically much lower than `frequencyHz`, so one envelope cycle
   * spans many motion cycles — this produces multi-second pauses and gentle
   * amplitude swells.
   */
  envelopeFrequencyHz: number;
  /** Seed for the envelope permutation table (decoupled from `seed`). */
  envelopeSeed: number;
  /**
   * Envelope raw sample (≈ [-1, 1]) at or below which the channel is fully
   * paused. Combined with `envActiveAbove` this sets the pause/motion duty
   * cycle: more negative → less frequent / shorter pauses; closer to 0 →
   * longer & more frequent pauses.
   */
  envPauseBelow: number;
  /**
   * Envelope raw sample at or above which the channel hits full amplitude.
   * The smoothstep between `envPauseBelow` and `envActiveAbove` produces the
   * gentle "waking up" / "winding down" amplitude ramp around pauses.
   */
  envActiveAbove: number;
}

export interface PerlinNoiseLayerOptions {
  channels?: Record<string, Partial<PerlinChannelConfig>>;
  weight?: number;
}

/**
 * Default per-channel configs. Envelope frequencies are intentionally slow
 * (~0.06–0.09 Hz ≈ 11–17 s per cycle) and desynced between channels so the
 * head doesn't pause on every axis at the exact same moment. Thresholds
 * favour pausing over moving — combined with the smoothstep ramp this
 * spends roughly half the time either paused or at reduced amplitude.
 */
const DEFAULT_CHANNELS: Record<string, PerlinChannelConfig> = {
  'head.yaw': {
    amplitude: 2.0,
    frequencyHz: 0.37,
    seed: 1013,
    envelopeFrequencyHz: 0.07,
    envelopeSeed: 11013,
    envPauseBelow: -0.1,
    envActiveAbove: 0.45,
  },
  'head.pitch': {
    amplitude: 2.0,
    frequencyHz: 0.42,
    seed: 2029,
    envelopeFrequencyHz: 0.08,
    envelopeSeed: 12029,
    envPauseBelow: -0.1,
    envActiveAbove: 0.45,
  },
  'head.roll': {
    amplitude: 2.0,
    frequencyHz: 0.31,
    seed: 3041,
    envelopeFrequencyHz: 0.06,
    envelopeSeed: 13041,
    envPauseBelow: -0.1,
    envActiveAbove: 0.45,
  },
  'body.x': {
    amplitude: 0.04,
    frequencyHz: 0.29,
    seed: 4051,
    envelopeFrequencyHz: 0.055,
    envelopeSeed: 14051,
    envPauseBelow: -0.1,
    envActiveAbove: 0.45,
  },
  'body.y': {
    amplitude: 0.04,
    frequencyHz: 0.33,
    seed: 5077,
    envelopeFrequencyHz: 0.065,
    envelopeSeed: 15077,
    envPauseBelow: -0.1,
    envActiveAbove: 0.45,
  },
};

export class PerlinNoiseLayer extends BaseLayer {
  readonly id = 'perlin-noise';
  // PerlinNoiseLayer drives generic head/body channels available in both cubism and vrm.
  readonly modelSupport = ['cubism', 'vrm'] as const;

  private readonly permutations: Map<string, Uint8Array> = new Map();
  private readonly envelopePermutations: Map<string, Uint8Array> = new Map();
  private readonly channelConfigs: Record<string, PerlinChannelConfig>;

  constructor(options: PerlinNoiseLayerOptions = {}) {
    super();
    this.channelConfigs = this.buildChannelConfigs(options.channels);

    for (const [ch, cfg] of Object.entries(this.channelConfigs)) {
      this.permutations.set(ch, buildPermutation(cfg.seed));
      this.envelopePermutations.set(ch, buildPermutation(cfg.envelopeSeed));
    }

    if (options.weight !== undefined) {
      this.setWeight(options.weight);
    }
  }

  private buildChannelConfigs(
    overrides?: Record<string, Partial<PerlinChannelConfig>>,
  ): Record<string, PerlinChannelConfig> {
    const result: Record<string, PerlinChannelConfig> = {};
    for (const [ch, def] of Object.entries(DEFAULT_CHANNELS)) {
      const ov = overrides?.[ch];
      result[ch] = {
        amplitude: ov?.amplitude ?? def.amplitude,
        frequencyHz: ov?.frequencyHz ?? def.frequencyHz,
        seed: ov?.seed ?? def.seed,
        envelopeFrequencyHz: ov?.envelopeFrequencyHz ?? def.envelopeFrequencyHz,
        envelopeSeed: ov?.envelopeSeed ?? def.envelopeSeed,
        envPauseBelow: ov?.envPauseBelow ?? def.envPauseBelow,
        envActiveAbove: ov?.envActiveAbove ?? def.envActiveAbove,
      };
    }
    return result;
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    const t = nowMs / 1000;
    const out: Record<string, number> = {};

    for (const [ch, cfg] of Object.entries(this.channelConfigs)) {
      const p = this.permutations.get(ch);
      const envP = this.envelopePermutations.get(ch);
      if (p === undefined || envP === undefined) continue;

      const raw = perlin1d(p, t * cfg.frequencyHz);
      const envRaw = perlin1d(envP, t * cfg.envelopeFrequencyHz);
      const env = envelopeValue(envRaw, cfg.envPauseBelow, cfg.envActiveAbove);
      out[ch] = raw * cfg.amplitude * env;
    }

    return out;
  }
}
