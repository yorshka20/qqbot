import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger';
import type { IdleClip } from './layers/clips/types';
import type {
  ActionMapEntry,
  ActionMapEntryClip,
  ActionMapEntryEnvelope,
  ActionSummary,
  ParamTarget,
  ResolvedAction,
} from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isClipEntry(e: ActionMapEntry): e is ActionMapEntryClip {
  return e.kind === 'clip';
}

export class ActionMap {
  private readonly entries: Record<string, ActionMapEntry | ActionMapEntry[]>;
  /** Preloaded clips keyed by action name. Array to support variant pools. */
  private readonly clipsByName: Map<string, IdleClip[]> = new Map();

  constructor(filePath?: string) {
    const resolved = filePath ?? fileURLToPath(new URL('../../assets/default-action-map.json', import.meta.url));
    const raw = readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, ActionMapEntry | ActionMapEntry[]>;
    this.entries = parsed;
    this.preloadClips(dirname(resolved));
  }

  private preloadClips(baseDir: string): void {
    for (const [name, raw] of Object.entries(this.entries)) {
      const variants = Array.isArray(raw) ? raw : [raw];
      const anyClip = variants.some(isClipEntry);
      if (!anyClip) continue;
      if (!variants.every(isClipEntry)) {
        logger.warn(`[ActionMap] Action "${name}" mixes clip and envelope variants; skipping`);
        delete this.entries[name];
        continue;
      }
      const clips: IdleClip[] = [];
      let ok = true;
      for (const variant of variants as ActionMapEntryClip[]) {
        const paths = Array.isArray(variant.clip) ? variant.clip : [variant.clip];
        for (const rel of paths) {
          const clipPath = resolve(baseDir, rel);
          try {
            const clipRaw = readFileSync(clipPath, 'utf8');
            const clip = JSON.parse(clipRaw) as IdleClip;
            if (typeof clip.duration !== 'number' || !Array.isArray(clip.tracks)) {
              throw new Error(`invalid clip schema at ${clipPath}`);
            }
            clips.push(clip);
          } catch (err) {
            logger.warn(`[ActionMap] Failed to load clip "${rel}" for action "${name}": ${(err as Error).message}`);
            ok = false;
          }
        }
      }
      if (!ok || clips.length === 0) {
        delete this.entries[name];
        continue;
      }
      this.clipsByName.set(name, clips);
    }
  }

  has(name: string): boolean {
    return name in this.entries;
  }

  getDuration(name: string): number | undefined {
    const raw = this.entries[name];
    if (!raw) return undefined;
    const variants = Array.isArray(raw) ? raw : [raw];
    if (variants.length === 0) return undefined;
    const clips = this.clipsByName.get(name);
    if (clips) {
      // clip variants — prefer variant.defaultDuration if set, else clip.duration*1000
      const durations = variants.map((v, i) => {
        const clip = clips[i] ?? clips[0];
        return (v as ActionMapEntryClip).defaultDuration ?? Math.round(clip.duration * 1000);
      });
      return Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    }
    const envDurations = variants
      .filter((v): v is ActionMapEntryEnvelope => v.kind !== 'clip')
      .map((v) => v.defaultDuration);
    if (envDurations.length === 0) return undefined;
    return Math.round(envDurations.reduce((s, d) => s + d, 0) / envDurations.length);
  }

  resolveAction(action: string, emotion: string, intensity: number): ResolvedAction | null {
    void emotion;
    const raw = this.entries[action];
    if (!raw) return null;
    const variants = Array.isArray(raw) ? raw : [raw];
    if (variants.length === 0) return null;
    const idx = Math.floor(Math.random() * variants.length);
    const variant = variants[idx];

    if (isClipEntry(variant)) {
      const clips = this.clipsByName.get(action);
      if (!clips || clips.length === 0) return null;
      const clip = clips[Math.min(idx, clips.length - 1)];
      const duration = variant.defaultDuration ?? Math.round(clip.duration * 1000);
      return {
        kind: 'clip',
        clip,
        endPose: variant.endPose,
        holdMs: variant.holdMs,
        duration,
        intensity,
      };
    }

    // envelope path
    const combined: ParamTarget[] = [...variant.params, ...(variant.accompaniment ?? [])];
    return {
      kind: 'envelope',
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
      duration: variant.defaultDuration,
      intensity,
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
      const clips = this.clipsByName.get(name);
      if (clips) {
        for (const clip of clips) {
          for (const track of clip.tracks) {
            if (seen.has(track.channel)) continue;
            seen.add(track.channel);
            channels.push(track.channel);
          }
        }
      } else {
        for (const v of variants) {
          if (v.kind === 'clip') continue; // defensive — preload culled
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
      }
      const duration = this.getDuration(name) ?? 0;
      out.push({
        name,
        defaultDuration: duration,
        category: variants[0].category,
        channels,
        description: variants[0].description,
      });
    }
    return out;
  }

  /**
   * Return the first preloaded IdleClip for an action, or null if the action
   * is non-clip or unknown. Used by PreviewServer `/clip/:name` debug route.
   */
  getClipByActionName(name: string): IdleClip | null {
    const clips = this.clipsByName.get(name);
    return clips?.[0] ?? null;
  }
}
