import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionMapEntry, ActionSummary, ParamTarget, ResolvedAction } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class ActionMap {
  private readonly entries: Record<string, ActionMapEntry | ActionMapEntry[]>;

  constructor(filePath?: string) {
    const resolved = filePath ?? fileURLToPath(new URL('../../assets/default-action-map.json', import.meta.url));
    const raw = readFileSync(resolved, 'utf8');
    this.entries = JSON.parse(raw) as Record<string, ActionMapEntry | ActionMapEntry[]>;
  }

  has(name: string): boolean {
    return name in this.entries;
  }

  getDuration(name: string): number | undefined {
    const raw = this.entries[name];
    if (!raw) return undefined;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return undefined;
      return Math.round(raw.reduce((s, v) => s + v.defaultDuration, 0) / raw.length);
    }
    return raw.defaultDuration;
  }

  resolveAction(action: string, emotion: string, intensity: number): ResolvedAction | null {
    void emotion;
    const raw = this.entries[action];
    if (!raw) return null;
    const variant = Array.isArray(raw) ? raw[Math.floor(Math.random() * raw.length)] : raw;
    const combined: ParamTarget[] = [...variant.params, ...(variant.accompaniment ?? [])];
    return {
      targets: combined.map((p) => ({
        channel: p.channel,
        targetValue: p.targetValue * intensity,
        weight: p.weight,
        oscillate: p.oscillate,
        leadMs: p.leadMs !== undefined ? clamp(p.leadMs, -1000, 1000) : undefined,
        lagMs: p.lagMs !== undefined ? clamp(p.lagMs, -1000, 1000) : undefined,
      })),
      endPose: variant.endPose,
      holdMs: variant.holdMs,
    };
  }

  /**
   * Public summary of every loaded action, used by consumers (PreviewServer
   * `/action-map` route, future prompt generation, etc.) to discover what
   * triggers are currently available without hardcoding names. Channel list
   * is deduplicated in original order.
   */
  listActions(): ActionSummary[] {
    const out: ActionSummary[] = [];
    for (const [name, raw] of Object.entries(this.entries)) {
      const variants = Array.isArray(raw) ? raw : [raw];
      const channels: string[] = [];
      const seen = new Set<string>();
      for (const v of variants) {
        for (const p of v.params) {
          if (seen.has(p.channel)) continue;
          seen.add(p.channel);
          channels.push(p.channel);
        }
        for (const p of v.accompaniment ?? []) {
          if (seen.has(p.channel)) continue;
          seen.add(p.channel);
          channels.push(p.channel);
        }
      }
      const avgDuration = Math.round(variants.reduce((s, v) => s + v.defaultDuration, 0) / variants.length);
      out.push({
        name,
        defaultDuration: avgDuration,
        category: variants[0].category,
        channels,
        description: variants[0].description,
      });
    }
    return out;
  }
}
