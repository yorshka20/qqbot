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
  /** Loop-pool mode: when set, on each wrap (elapsed >= duration) a random
   *  variant from this pool replaces `config.loopClip` so a pooled action
   *  like `vrm_idle_loop` rotates through its variants instead of looping
   *  one forever. Null = single-clip loop mode (legacy). */
  private loopPool: IdleClip[] | null = null;
  /** Cached union of channels the loop clip(s) write — recomputed on
   *  setLoopClip / setLoopClips. Returned from `getActiveChannels()` so the
   *  occupancy arbiter blocks wander/locomotion while the idle loop owns
   *  the leg/spine/hips quat channels. Frozen-frame state still reports the
   *  same channels because the pose is visually held, even when not ticking. */
  private loopChannels: ReadonlySet<string> | null = null;
  /** Whether the previous tick observed a truly-idle activity. Flips back to
   *  `false` on exit so re-entry reseeds the gap-mode timer / loop-mode
   *  anchor cleanly. */
  private wasIdle = true;

  constructor(config: Partial<IdleMotionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Switch to / update single-clip loop mode at runtime. Pass `null` to
   * return to gap mode. Called by `AvatarService` after compiler init once
   * the configured `loopClipActionName` resolves to a single preloaded clip.
   */
  setLoopClip(clip: IdleClip | null): void {
    this.loopPool = null;
    this.config.loopClip = clip ?? undefined;
    this.loopChannels = clip ? channelSetOf([clip]) : null;
    // Reset state so the mode switch starts cleanly on the next tick.
    this.active = null;
    this.loopStartMs = 0;
    this.frozenElapsedSec = 0;
    this.cached = null;
  }

  /**
   * Switch to loop-pool mode: the layer loops one variant at a time, picking
   * a fresh random variant from `clips` on every wrap. Used for pooled idle
   * actions (e.g. `vrm_idle_loop`'s 16 variants) so the resting pose has
   * built-in variety without exiting loop mode. Pass an empty array to
   * disable (returns to gap mode). Single-element arrays are equivalent to
   * `setLoopClip`.
   */
  setLoopClips(clips: readonly IdleClip[]): void {
    if (clips.length === 0) {
      this.setLoopClip(null);
      return;
    }
    if (clips.length === 1) {
      this.setLoopClip(clips[0]);
      return;
    }
    this.loopPool = [...clips];
    this.config.loopClip = clips[Math.floor(Math.random() * clips.length)];
    // Union across the whole pool — any variant might be the active one at
    // any given tick, so they all need to register as occupied for arbiter.
    this.loopChannels = channelSetOf(clips);
    this.active = null;
    this.loopStartMs = 0;
    this.frozenElapsedSec = 0;
    this.cached = null;
  }

  /**
   * Channels currently owned by this layer — read by the occupancy arbiter.
   *
   * Loop mode: the layer continuously writes (or holds frozen) the loop
   * clip's tracks even while gated off, so its channels are owned for the
   * full lifetime of the loop configuration.
   *
   * Gap mode: only owns channels while a clip is actively playing; between
   * clips the layer emits nothing and returns empty.
   */
  getActiveChannels(): ReadonlySet<string> {
    if (this.loopChannels) return this.loopChannels;
    if (this.active) return channelSetOf([this.active.clip]);
    return EMPTY_CHANNEL_SET;
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
      let loopClip = this.config.loopClip;
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
        const totalElapsedSec = (nowMs - this.loopStartMs) / 1000;
        if (totalElapsedSec >= loopClip.duration) {
          // Wrap boundary — in pool mode, rotate to a fresh variant so a
          // pooled idle action animates with built-in variety; in single-
          // clip mode, just loop the same clip again.
          if (this.loopPool && this.loopPool.length > 1) {
            loopClip = this.loopPool[Math.floor(Math.random() * this.loopPool.length)];
            this.config.loopClip = loopClip;
          }
          this.loopStartMs = nowMs;
          elapsedSec = 0;
        } else {
          elapsedSec = totalElapsedSec;
        }
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

const EMPTY_CHANNEL_SET: ReadonlySet<string> = new Set();

function channelSetOf(clips: readonly IdleClip[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const c of clips) for (const t of c.tracks) set.add(t.channel);
  return set;
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
