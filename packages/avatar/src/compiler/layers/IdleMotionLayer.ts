import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import type { EasingType } from '../types';
import { BaseLayer } from './BaseLayer';
import { DEFAULT_IDLE_CLIPS, type IdleClip } from './clips';

/**
 * Plays idle-motion clips while the bot is **truly idle** — i.e.
 * `pose === 'neutral'` AND `ambientGain >= 1.0`. Two modes:
 *
 * 1. **Gap mode** (default): picks a random clip from the pool, plays it
 *    once, waits a random gap, repeats. Matches the legacy Cubism-era idle
 *    burst behavior where short clips briefly perturb otherwise-static
 *    channels.
 *
 * 2. **Loop mode** (`loopClip` set): plays the single clip continuously,
 *    wrapping time back to 0 when `elapsed >= clip.duration`. Intended for
 *    VRM idle VRMAs whose keyframes already encode the character's rest
 *    pose (A-pose + breathing). Pairs with `CompilerConfig.restPose` to
 *    cover non-idle-clip channels with static fallback values.
 *
 * ### Per-channel exclusion
 *
 * `sample()` receives the set of channels active discrete animations will
 * drive this tick. The idle clip holds **absolute** values (route 1 in the
 * T-pose design), so any channel also touched by an action would produce a
 * "double bias" if blended additively — e.g. `rest=-1.2` + `action=+0.8` =
 * `-0.4`, a half-arm. To avoid this, contributions for channels in
 * `activeChannels` are dropped from the output map. Channels the action
 * doesn't touch continue receiving idle motion, so a wave action can play
 * while the left arm + spine continue breathing.
 */
interface IdleMotionConfig {
  /** Gap-mode clip pool. Ignored when `loopClip` is set. Defaults to DEFAULT_IDLE_CLIPS. */
  clips: IdleClip[];
  /** Single clip played in continuous loop mode. When set, `clips`/gap logic is bypassed. */
  loopClip?: IdleClip;
  /** Minimum gap between clips in ms (gap mode only). */
  gapMin: number;
  /** Maximum gap between clips in ms (gap mode only). */
  gapMax: number;
  /** Default easing when a clip track doesn't specify one. */
  defaultEasing: EasingType;
}

const DEFAULT_CONFIG: IdleMotionConfig = {
  clips: DEFAULT_IDLE_CLIPS,
  gapMin: 2000,
  gapMax: 6000,
  defaultEasing: 'easeInOutCubic',
};

interface ActiveClip {
  clip: IdleClip;
  startMs: number;
}

function isTrulyIdle(activity: AvatarActivity): boolean {
  return activity.pose === 'neutral' && activity.ambientGain >= 1.0;
}

export class IdleMotionLayer extends BaseLayer {
  readonly id = 'idle-motion';

  private readonly config: IdleMotionConfig;
  private active: ActiveClip | null = null;
  private nextClipAt = 0;
  /** Loop-mode timeline anchor: the nowMs at which the current loop cycle
   *  started. Reset when the layer re-enters idle so the clip always
   *  resumes from t=0 rather than mid-cycle after an interruption. */
  private loopStartMs = 0;
  /** Whether the previous tick observed a truly-idle activity. Flips back to
   *  `false` on exit so re-entry reseeds the next-clip timer cleanly. */
  private wasIdle = true;

  constructor(config: Partial<IdleMotionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Switch to / update loop mode at runtime. Pass `null` to return to gap
   * mode. Called by `AvatarService` after compiler initialization once the
   * configured `loopClipActionName` resolves to a preloaded clip.
   */
  setLoopClip(clip: IdleClip | null): void {
    this.config.loopClip = clip ?? undefined;
    // Reset state so the mode switch starts cleanly on the next tick.
    this.active = null;
    this.loopStartMs = 0;
  }

  override reset(): void {
    this.active = null;
    this.nextClipAt = 0;
    this.loopStartMs = 0;
    this.wasIdle = true;
  }

  sample(
    nowMs: number,
    activity: AvatarActivity,
    activeChannels?: ReadonlySet<string>,
  ): Record<string, number> {
    // Not truly idle? Abandon any running clip; compiler's spring-damper
    // smooths channels back to restPose baseline / identity.
    if (!isTrulyIdle(activity)) {
      if (this.active) this.active = null;
      this.loopStartMs = 0;
      this.wasIdle = false;
      return {};
    }

    // Loop mode: single clip, wrap time at duration.
    if (this.config.loopClip) {
      if (!this.wasIdle || this.loopStartMs === 0) {
        this.loopStartMs = nowMs;
      }
      this.wasIdle = true;
      const loopClip = this.config.loopClip;
      const elapsedSec = ((nowMs - this.loopStartMs) / 1000) % loopClip.duration;
      const sampled = sampleClip(loopClip, elapsedSec, this.config.defaultEasing);
      return filterActiveChannels(sampled.scalar, activeChannels);
    }

    // Gap mode (legacy).
    // First tick in idle, or after re-entering idle — (re)seed the next clip timer.
    if (!this.wasIdle || this.nextClipAt === 0) {
      this.nextClipAt = nowMs + this.randomGap();
    }
    this.wasIdle = true;

    // No clip active: wait for next clip time to fire.
    if (!this.active) {
      if (nowMs < this.nextClipAt) return {};
      this.active = { clip: this.pickClip(), startMs: nowMs };
    }

    // Sample the active clip; if it ended, schedule next gap.
    const elapsedSec = (nowMs - this.active.startMs) / 1000;
    if (elapsedSec >= this.active.clip.duration) {
      this.active = null;
      this.nextClipAt = nowMs + this.randomGap();
      return {};
    }
    const sampled = sampleClip(this.active.clip, elapsedSec, this.config.defaultEasing);
    return filterActiveChannels(sampled.scalar, activeChannels);
  }

  private pickClip(): IdleClip {
    const pool = this.config.clips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private randomGap(): number {
    return this.config.gapMin + Math.random() * Math.max(0, this.config.gapMax - this.config.gapMin);
  }
}

function filterActiveChannels(
  raw: Record<string, number>,
  activeChannels?: ReadonlySet<string>,
): Record<string, number> {
  if (!activeChannels || activeChannels.size === 0) return raw;
  const out: Record<string, number> = {};
  for (const [ch, v] of Object.entries(raw)) {
    if (activeChannels.has(ch)) continue;
    out[ch] = v;
  }
  return out;
}
