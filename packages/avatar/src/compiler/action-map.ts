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
  ModelKind,
  ParamTarget,
  ResolvedAction,
} from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isClipEntry(e: ActionMapEntry): e is ActionMapEntryClip {
  return e.kind === 'clip';
}

/**
 * Collect every channel name an envelope-kind entry writes this entry
 * (params + accompaniment + endPose). Returns empty array for clip-kind —
 * clip channels are inspected separately after preload.
 */
function collectEnvelopeChannels(entry: ActionMapEntry): string[] {
  if (isClipEntry(entry)) return [];
  const out: string[] = [];
  for (const p of entry.params) out.push(p.channel);
  for (const p of entry.accompaniment ?? []) out.push(p.channel);
  for (const p of entry.endPose ?? []) out.push(p.channel);
  return out;
}

/**
 * Auto-derive model compatibility from channel names when no explicit
 * `modelSupport` is declared.
 *
 * Rule: a channel whose name begins with `vrm.` is only renderable on the
 * VRM pipeline (the Cubism renderer has no such channel aliases). An entry
 * touching ANY `vrm.*` channel is therefore VRM-only. All other entries
 * auto-derive to `'both'` (renderer-side channel-map resolves `head.*`,
 * `body.*`, `eye.*`, `brow`, `mouth.*` across both models).
 *
 * NOTE: This filter ONLY encodes "can the renderer map these channels". It
 * does NOT encode runtime pose conflicts between actions and the currently
 * loaded VRM idle loop clip — e.g. `arm.left` / `arm.right` aliases collide
 * with the peace_sign idle's `vrm.leftUpperArm` / `vrm.rightUpperArm`. Those
 * cases still use explicit `modelSupport: 'cubism'` in the action-map, and
 * see `.claude-learnings/avatar.md` for the dynamic-conflict-set TODO.
 */
function deriveFromChannels(channels: readonly string[]): 'vrm' | 'both' {
  for (const c of channels) {
    if (c.startsWith('vrm.')) return 'vrm';
  }
  return 'both';
}

/**
 * Returns true when the entry is compatible with the given model kind.
 * Explicit `modelSupport` always wins. When absent, compatibility is
 * auto-derived from the entry's channel names (see `deriveFromChannels`).
 * When modelKind is null, all entries are compatible (no filtering).
 */
function isEntryCompatible(
  entry: ActionMapEntry,
  modelKind: ModelKind | null | undefined,
  clipChannels?: readonly string[],
): boolean {
  if (modelKind == null) return true;
  const ms = entry.modelSupport;
  if (ms === 'both') return true;
  if (ms === 'cubism' || ms === 'vrm') return ms === modelKind;
  // No explicit declaration — auto-derive from channels.
  const channels = isClipEntry(entry) ? (clipChannels ?? []) : collectEnvelopeChannels(entry);
  const derived = deriveFromChannels(channels);
  if (derived === 'both') return true;
  return derived === modelKind;
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

  resolveAction(
    action: string,
    emotion: string,
    intensity: number,
    modelKind?: ModelKind | null,
  ): ResolvedAction | null {
    void emotion;
    const raw = this.entries[action];
    if (!raw) return null;
    const allVariants = Array.isArray(raw) ? raw : [raw];
    if (allVariants.length === 0) return null;

    // Filter to compatible variants first, then pick randomly among them.
    // This ensures an incompatible variant is never accidentally picked and
    // then returned as null — the whole action correctly returns null when
    // no compatible variant exists.
    const clipChannels = this.clipChannelsFor(action);
    const variants =
      modelKind != null ? allVariants.filter((v) => isEntryCompatible(v, modelKind, clipChannels)) : allVariants;
    if (variants.length === 0) return null;

    const idx = Math.floor(Math.random() * variants.length);
    const variant = variants[idx];

    if (isClipEntry(variant)) {
      const clips = this.clipsByName.get(action);
      if (!clips || clips.length === 0) return null;
      // Use the original (unfiltered) index so the clip matches its variant entry.
      const allIdx = allVariants.indexOf(variant);
      const clip = clips[Math.min(allIdx < 0 ? idx : allIdx, clips.length - 1)];
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
   * Public summary of loaded actions compatible with the given model kind.
   * When modelKind is null or undefined, all actions are returned.
   * Channel list is deduplicated in original order.
   */
  listActions(modelKind?: ModelKind | null): ActionSummary[] {
    const out: ActionSummary[] = [];
    for (const [name, raw] of Object.entries(this.entries)) {
      const allVariants = Array.isArray(raw) ? raw : [raw];
      // Filter to compatible variants; skip action entirely if none are compatible.
      const clipChannels = this.clipChannelsFor(name);
      const variants =
        modelKind != null ? allVariants.filter((v) => isEntryCompatible(v, modelKind, clipChannels)) : allVariants;
      if (variants.length === 0) continue;
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

  /**
   * Return the deduplicated set of channel names written by any preloaded
   * clip variant for this action, or undefined if no clips are loaded under
   * this name. Used for clip-kind auto-derivation when `modelSupport` is
   * absent.
   */
  private clipChannelsFor(name: string): readonly string[] | undefined {
    const clips = this.clipsByName.get(name);
    if (!clips || clips.length === 0) return undefined;
    const seen = new Set<string>();
    for (const clip of clips) {
      for (const track of clip.tracks) seen.add(track.channel);
    }
    return [...seen];
  }
}
