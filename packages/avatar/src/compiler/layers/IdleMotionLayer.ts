import type { BotState } from '../../state/types';
import { applyEasing } from '../easing';
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
 * Only plays while `state === 'idle'`. In any other state the layer emits
 * nothing and lets the active discrete action / transition animation own the
 * channels that clip would have touched. The LayerManager's gate policy
 * still applies on top.
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

export class IdleMotionLayer extends BaseLayer {
  readonly id = 'idle-motion';

  private readonly config: IdleMotionConfig;
  private active: ActiveClip | null = null;
  private nextClipAt = 0;
  /** Bot-state observed on the previous tick — used to cancel on exit-idle. */
  private lastState: BotState = 'idle';

  constructor(config: Partial<IdleMotionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  override reset(): void {
    this.active = null;
    this.nextClipAt = 0;
    this.lastState = 'idle';
  }

  sample(nowMs: number, state: BotState): Record<string, number> {
    // Exited idle? Abandon any running clip; rely on the compiler's low-pass
    // to smoothly release channels back to baseline.
    if (state !== 'idle') {
      if (this.active) this.active = null;
      this.lastState = state;
      return {};
    }

    // First tick in idle, or after re-entering idle — (re)seed the next clip timer.
    if (this.lastState !== 'idle' || this.nextClipAt === 0) {
      this.nextClipAt = nowMs + this.randomGap();
    }
    this.lastState = state;

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
    return this.sampleClip(this.active.clip, elapsedSec);
  }

  private sampleClip(clip: IdleClip, tSec: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const track of clip.tracks) {
      const kfs = track.keyframes;
      if (kfs.length === 0) continue;

      // Before first keyframe — hold the first value.
      if (tSec <= kfs[0].time) {
        out[track.channel] = (out[track.channel] ?? 0) + kfs[0].value;
        continue;
      }
      // After last keyframe — hold the last value.
      const last = kfs[kfs.length - 1];
      if (tSec >= last.time) {
        out[track.channel] = (out[track.channel] ?? 0) + last.value;
        continue;
      }
      // Interpolate between the bracketing keyframes.
      let i = 0;
      while (i < kfs.length - 1 && kfs[i + 1].time < tSec) i++;
      const a = kfs[i];
      const b = kfs[i + 1];
      const span = b.time - a.time;
      const progress = span <= 0 ? 1 : (tSec - a.time) / span;
      const eased = applyEasing(progress, track.easing ?? this.config.defaultEasing);
      const value = a.value + (b.value - a.value) * eased;
      out[track.channel] = (out[track.channel] ?? 0) + value;
    }
    return out;
  }

  private pickClip(): IdleClip {
    const pool = this.config.clips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private randomGap(): number {
    return this.config.gapMin + Math.random() * Math.max(0, this.config.gapMax - this.config.gapMin);
  }
}
