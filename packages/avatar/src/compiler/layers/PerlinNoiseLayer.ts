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

export interface PerlinChannelConfig {
  amplitude: number;
  frequencyHz: number;
  seed: number;
}

export interface PerlinNoiseLayerOptions {
  channels?: Record<string, Partial<PerlinChannelConfig>>;
  weight?: number;
}

const DEFAULT_CHANNELS: Record<string, PerlinChannelConfig> = {
  'head.yaw': { amplitude: 2.0, frequencyHz: 0.37, seed: 1013 },
  'head.pitch': { amplitude: 2.0, frequencyHz: 0.42, seed: 2029 },
  'head.roll': { amplitude: 2.0, frequencyHz: 0.31, seed: 3041 },
  'body.x': { amplitude: 0.04, frequencyHz: 0.29, seed: 4051 },
  'body.y': { amplitude: 0.04, frequencyHz: 0.33, seed: 5077 },
};

export class PerlinNoiseLayer extends BaseLayer {
  readonly id = 'perlin-noise';

  private readonly permutations: Map<string, Uint8Array> = new Map();
  private readonly channelConfigs: Record<string, PerlinChannelConfig>;

  constructor(options: PerlinNoiseLayerOptions = {}) {
    super();
    this.channelConfigs = this.buildChannelConfigs(options.channels);

    for (const [ch, cfg] of Object.entries(this.channelConfigs)) {
      this.permutations.set(ch, buildPermutation(cfg.seed));
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
      if (p === undefined) continue;
      const freq = cfg.frequencyHz;
      const raw = perlin1d(p, t * freq);
      out[ch] = raw * cfg.amplitude;
    }

    return out;
  }
}
