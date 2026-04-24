import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import type { EasingType } from '../types';
import { BaseLayer } from './BaseLayer';
import { DEFAULT_IDLE_CLIPS, type IdleClip } from './clips';

/**
 * Plays idle-motion clips. Two modes:
 *
 * 1. **Gap mode** (default): picks a random clip from the pool, plays it
 *    once, waits a random gap, repeats. Active only while `isTrulyIdle`
 *    (`pose === 'neutral'` AND `ambientGain >= 1.0`). Short one-shot clips
 *    have no meaningful "frozen" state, so on gate exit the layer simply
 *    stops emitting.
 *
 * 2. **Loop mode** (`loopClip` set): plays the single clip continuously,
 *    wrapping time back to 0 when `elapsed >= clip.duration`. The loop clip
 *    is the **sole source of truth** for the character's resting pose — so
 *    on gate exit (speaking / listening / thinking) the layer does NOT stop
 *    emitting. Instead it freezes the clip at the current elapsed time and
 *    re-emits that same frame every tick. When the gate re-opens the
 *    timeline resumes from the frozen frame (not from t=0), keeping the
 *    posture visually continuous across state transitions.
 *
 * ### Per-channel exclusion
 *
 * `sample()` receives the set of channels active discrete animations will
 * drive this tick. The idle clip holds **absolute** channel values, so any
 * channel also touched by an action would produce a "double bias" if blended
 * additively. To avoid this, contributions for channels in `activeChannels`
 * are dropped from the output map. Channels the action doesn't touch
 * continue receiving idle motion, so a wave action can play while the left
 * arm + spine continue breathing.
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
  // IdleMotionLayer supports both cubism (scalar idle clips) and vrm (quat idle clips).
  readonly modelSupport = ['cubism', 'vrm'] as const;

  private readonly config: IdleMotionConfig;
  private active: ActiveClip | null = null;
  private nextClipAt = 0;
  /** Per-tick frame cache. `sample()` advances state + clip time and writes
   *  both scalar and quat maps here; `sampleQuat()` reads from the same
   *  cached entry so state isn't double-advanced within a single tick.
   *  LayerManager always calls `sample()` first, so a stale `nowMs` means
   *  `sampleQuat()` was called without a preceding `sample()` — we return
   *  empty rather than re-running state logic. */
  private cached: {
    nowMs: number;
    scalar: Record<string, number>;
    quat: Record<string, { x: number; y: number; z: number; w: number }>;
  } | null = null;
  /** Loop-mode timeline anchor: the `nowMs` corresponding to `t=0` of the
   *  current loop cycle. When the gate re-opens after a freeze, this is
   *  rebased to `nowMs - frozenElapsedSec * 1000` so the clip continues
   *  forward from the frozen frame rather than jumping back to t=0. */
  private loopStartMs = 0;
  /** Loop-mode freeze point: the clip time (seconds) at which the loop was
   *  frozen when the truly-idle gate closed. Re-emitted every tick while
   *  gated off. */
  private frozenElapsedSec = 0;
  /** Whether the previous tick observed a truly-idle activity. Flips back to
   *  `false` on exit so re-entry reseeds the gap-mode timer / loop-mode
   *  anchor cleanly. */
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
    this.frozenElapsedSec = 0;
    this.cached = null;
  }

  override reset(): void {
    this.active = null;
    this.nextClipAt = 0;
    this.loopStartMs = 0;
    this.frozenElapsedSec = 0;
    this.wasIdle = true;
    this.cached = null;
  }

  sample(nowMs: number, activity: AvatarActivity, activeChannels?: ReadonlySet<string>): Record<string, number> {
    const frame = this.advanceAndSample(nowMs, activity);
    if (!frame) {
      this.cached = { nowMs, scalar: {}, quat: {} };
      return {};
    }
    const scalar = filterActiveChannels(frame.scalar, activeChannels);
    // Quat is intentionally NOT filtered against activeChannels. The
    // AnimationCompiler reads the pre-discrete quat contribution for a bone
    // as the slerp anchor so a clip's release tail blends back to the idle
    // pose (not identity / T-pose). Scalar still gets filtered to avoid the
    // additive double-bias on delta channels.
    this.cached = { nowMs, scalar, quat: frame.quat };
    return scalar;
  }

  sampleQuat(
    nowMs: number,
    _activity: AvatarActivity,
    _activeChannels?: ReadonlySet<string>,
  ): Record<string, { x: number; y: number; z: number; w: number }> {
    // LayerManager calls sample() before sampleQuat() within the same tick,
    // so the cached frame for `nowMs` is already populated with the filtered
    // quat map. A cache miss means sampleQuat was called standalone — return
    // empty rather than re-running state mutations.
    if (!this.cached || this.cached.nowMs !== nowMs) return {};
    return this.cached.quat;
  }

  /**
   * Advance the layer's timeline by one tick and return the sampled clip
   * frame (scalar + quat), or null if nothing is playing. This is the sole
   * site that mutates `wasIdle` / `loopStartMs` / `frozenElapsedSec` /
   * `active` / `nextClipAt`, so callers can rely on the returned frame being
   * consistent with the post-call state.
   */
  private advanceAndSample(
    nowMs: number,
    activity: AvatarActivity,
  ): { scalar: Record<string, number>; quat: Record<string, { x: number; y: number; z: number; w: number }> } | null {
    const truly = isTrulyIdle(activity);

    // Loop mode — the loop clip is the sole source of truth for resting pose,
    // so freeze on gate exit rather than stop emitting.
    if (this.config.loopClip) {
      const loopClip = this.config.loopClip;
      let elapsedSec: number;

      if (truly) {
        if (!this.wasIdle) {
          // Gate just re-opened — rebase so the clip resumes from the frozen
          // frame and continues forward in time.
          this.loopStartMs = nowMs - this.frozenElapsedSec * 1000;
        } else if (this.loopStartMs === 0) {
          // First tick after boot / mode switch.
          this.loopStartMs = nowMs;
        }
        this.wasIdle = true;
        elapsedSec = ((nowMs - this.loopStartMs) / 1000) % loopClip.duration;
        this.frozenElapsedSec = elapsedSec;
      } else {
        // Gated off — re-emit the last idle-tick frame every tick. Freeze
        // point is the most recent on-screen posture, kept in sync at the
        // end of every idle tick above.
        this.wasIdle = false;
        elapsedSec = this.frozenElapsedSec;
      }
      // TODO(perf): while gate is off `elapsedSec` is constant, so
      // `sampleClip(loopClip, frozenElapsedSec)` returns the same frame every
      // tick. Cache the sampled frame until `frozenElapsedSec` changes (i.e.
      // until gate reopens) to skip ~100 binary-search track samples per
      // off-gate tick. Deferred: no measured perf problem today, and caching
      // here would add state that could mask bugs in the freeze/resume
      // transition. Revisit if profiling flags this site.
      return sampleClip(loopClip, elapsedSec, this.config.defaultEasing);
    }

    // Gap mode — silent on gate exit (short one-shots have no meaningful freeze).
    if (!truly) {
      if (this.active) this.active = null;
      this.wasIdle = false;
      return null;
    }

    // First tick in idle, or after re-entering idle — (re)seed the next clip timer.
    if (!this.wasIdle || this.nextClipAt === 0) {
      this.nextClipAt = nowMs + this.randomGap();
    }
    this.wasIdle = true;

    // No clip active: wait for next clip time to fire.
    if (!this.active) {
      if (nowMs < this.nextClipAt) return null;
      this.active = { clip: this.pickClip(), startMs: nowMs };
    }

    // Sample the active clip; if it ended, schedule next gap.
    const elapsedSec = (nowMs - this.active.startMs) / 1000;
    if (elapsedSec >= this.active.clip.duration) {
      this.active = null;
      this.nextClipAt = nowMs + this.randomGap();
      return null;
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

function filterActiveChannels<V>(raw: Record<string, V>, activeChannels?: ReadonlySet<string>): Record<string, V> {
  if (!activeChannels || activeChannels.size === 0) return raw;
  const out: Record<string, V> = {};
  for (const [ch, v] of Object.entries(raw)) {
    if (activeChannels.has(ch)) continue;
    out[ch] = v;
  }
  return out;
}
