import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import type { EasingType } from '../types';
import { BaseLayer } from './BaseLayer';
import { DEFAULT_IDLE_CLIPS, type IdleClip } from './clips';

/**
 * Plays a random sequence of authored idle clips (keyframe tracks), one at a
 * time, with short random gaps in between. Each clip additively contributes
 * to channels on top of BreathLayer/EyeGazeLayer/AutoBlinkLayer — the whole
 * stack forms a rich, non-repeating idle motion analogous to Cubism's Idle
 * motion group playback.
 *
 * Only plays when the bot is **truly idle** — i.e. `pose === 'neutral'` AND
 * `ambientGain >= 1.0`. Any deviation (pose change or gain suppression while
 * speaking / thinking) abandons the running clip and emits nothing, letting
 * active discrete / transition animations own the channels without fighting
 * the clip for dominance.
 */
interface IdleMotionConfig {
  /** Clip pool to pick from. Defaults to DEFAULT_IDLE_CLIPS. */
  clips: IdleClip[];
  /** Minimum gap between clips in ms. */
  gapMin: number;
  /** Maximum gap between clips in ms. */
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
  /** Whether the previous tick observed a truly-idle activity. Flips back to
   *  `false` on exit so re-entry reseeds the next-clip timer cleanly. */
  private wasIdle = true;

  constructor(config: Partial<IdleMotionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  override reset(): void {
    this.active = null;
    this.nextClipAt = 0;
    this.wasIdle = true;
  }

  sample(nowMs: number, activity: AvatarActivity): Record<string, number> {
    // Not truly idle? Abandon any running clip; rely on the compiler's low-pass
    // to smoothly release channels back to baseline.
    if (!isTrulyIdle(activity)) {
      if (this.active) this.active = null;
      this.wasIdle = false;
      return {};
    }

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
    return sampleClip(this.active.clip, elapsedSec, this.config.defaultEasing);
  }

  private pickClip(): IdleClip {
    const pool = this.config.clips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private randomGap(): number {
    return this.config.gapMin + Math.random() * Math.max(0, this.config.gapMax - this.config.gapMin);
  }
}
