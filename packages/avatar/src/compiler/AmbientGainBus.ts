import { logger } from '../utils/logger';

export type AmbientSourceName = 'idle' | 'mind' | 'activity';

export interface AmbientBusSnapshot {
  /** Active sources only (cleared / never-set sources are omitted). */
  sources: Partial<Record<AmbientSourceName, number>>;
  /** Resolved value after reducer + smoothing. Always finite. */
  resolved: number;
}

export interface AmbientGainBusOptions {
  /** Reducer over active source values. Default `(vs) => Math.min(...vs)`. */
  reducer?: (values: number[]) => number;
  /** Time constant for first-order lerp toward the new resolved target,
   *  in ms. Default 1000. tick(dt) moves smoothed `dt / (dt + tau)` toward
   *  raw resolved. tau=1000 → ~63% in 1s, ~95% in 3s. */
  smoothingTauMs?: number;
  /** Fallback when no source is set. Default 1.0 (open gate). */
  emptyFallback?: number;
}

/**
 * Multi-source ambient-gain bus. Each source ('idle' | 'mind' |
 * 'activity') is upserted independently; resolved value is reducer(sources)
 * (default min) lerp-smoothed by `tick(dtMs)`. Bus holds no timers —
 * caller drives `tick`. Snapshot exposes active sources + smoothed value
 * for HUD diagnostics.
 *
 * Consumers see only `AvatarActivity.ambientGain` (single number) — bus
 * is owned privately by AvatarService and writes its resolved value back
 * into that field.
 */
export class AmbientGainBus {
  private readonly sources = new Map<AmbientSourceName, number>();
  private readonly tau: number;
  private readonly fallback: number;
  private readonly reducer: (values: number[]) => number;
  private smoothed: number;

  constructor(opts: AmbientGainBusOptions = {}) {
    this.tau = opts.smoothingTauMs ?? 1000;
    this.fallback = opts.emptyFallback ?? 1.0;
    this.reducer = opts.reducer ?? ((values) => Math.min(...values));
    this.smoothed = this.fallback;
  }

  setSource(name: AmbientSourceName, value: number): void {
    if (!Number.isFinite(value)) {
      logger.warn(`[AmbientGainBus] rejected non-finite value for source '${name}': ${value}`);
      return;
    }
    this.sources.set(name, Math.max(0, value));
  }

  clearSource(name: AmbientSourceName): void {
    this.sources.delete(name);
  }

  tick(dtMs: number): number {
    if (dtMs <= 0) return this.smoothed;
    const raw = this.sources.size === 0 ? this.fallback : this.reducer(Array.from(this.sources.values()));
    const alpha = dtMs / (dtMs + this.tau);
    this.smoothed += (raw - this.smoothed) * alpha;
    return this.smoothed;
  }

  snapshot(): AmbientBusSnapshot {
    return {
      sources: Object.fromEntries(this.sources) as Partial<Record<AmbientSourceName, number>>,
      resolved: this.smoothed,
    };
  }
}
