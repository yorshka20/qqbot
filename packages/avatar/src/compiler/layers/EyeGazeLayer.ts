import type { AvatarActivity } from '../../state/types';
import type { GazeTarget } from '../../tags';
import { BaseLayer } from './BaseLayer';

/**
 * Eye-ball gaze layer. Drives `eye.ball.x` and `eye.ball.y` in normalized
 * [-1, 1] (matches Cubism `ParamEyeBallX/Y`) with two combined behaviors:
 *
 * 1. **Slow drift** via a discrete-time Ornstein-Uhlenbeck process (mean-
 *    reverting random walk). Each tick the position moves `θ * (target - pos)`
 *    toward the current saccade target, plus a small Gaussian noise step.
 *    This produces smooth, biological-looking micro-drift that never walks
 *    far from center.
 *
 * 2. **Saccades** — every 3-10s, pick a new random target on the unit disk
 *    (bias toward center via r = Math.random() squared). OU process then
 *    drifts toward that target over the next few hundred ms, producing the
 *    characteristic "sudden jump, then hold" rhythm of human gaze.
 *
 * Gaze keeps running even during `speaking` / `thinking` states because a
 * frozen gaze looks lifeless. The global gate still scales amplitude down
 * (via LayerManager) so it's subtler than in idle.
 */
interface GazeConfig {
  /** OU mean-reversion strength per tick (0..1). Higher = snappier. */
  theta: number;
  /** Gaussian noise stddev per tick (normalized units). */
  noiseSigma: number;
  /** Amplitude of the gaze region, normalized. 1.0 = full eye-ball range. */
  maxRadius: number;
  /** Minimum interval between saccades (ms). */
  saccadeIntervalMin: number;
  /** Maximum interval between saccades (ms). */
  saccadeIntervalMax: number;
}

const DEFAULT_GAZE_CONFIG: GazeConfig = {
  theta: 0.08,
  noiseSigma: 0.015,
  maxRadius: 0.6,
  saccadeIntervalMin: 3000,
  saccadeIntervalMax: 10000,
};

/**
 * Downward/avoidant y-offset applied to the OU output when
 * `defaultContactPref` is set to 0 (full avoidance). Values between 0 and 1
 * linearly interpolate from full-avoidance to no offset.
 *
 * Using a value of 0.3 keeps the offset large enough to be visually distinct
 * (and detectable in unit tests) while staying comfortably within the [-1, 1]
 * eye-ball range even when the OU position is near its maxRadius boundary.
 */
const AVOIDANT_Y_OFFSET = 0.3;

export class EyeGazeLayer extends BaseLayer {
  readonly id = 'eye-gaze';
  // EyeGazeLayer drives eye.ball.x/y channels supported by both cubism and vrm renderers.
  readonly modelSupport = ['cubism', 'vrm'] as const;

  private readonly config: GazeConfig;
  private posX = 0;
  private posY = 0;
  private targetX = 0;
  private targetY = 0;
  private nextSaccadeAt = 0;
  private lastSampleAt = 0;
  private override: { x: number; y: number } | null = null;

  /**
   * Default gaze contact preference, set by {@link setDefaultContactPreference}.
   * `null` = no preference (exact original OU behaviour).
   * `1`   = biased toward camera center (no downward offset).
   * `0`   = avoidant / downward default (full AVOIDANT_Y_OFFSET applied).
   * Values between 0 and 1 linearly interpolate the offset.
   *
   * This field only influences the no-override path. Explicit
   * `setGazeTarget()` calls always win regardless of this value.
   */
  private defaultContactPref: number | null = null;

  /**
   * When true, the no-override path returns `(0, 0)` instead of running the
   * OU drift + saccade pipeline. Combined with `compiler.debugQuiet` this
   * makes explicit `setGazeTarget()` calls the only source of eye motion, so
   * wander glances / LLM gaze tags are unambiguously visible during testing.
   * An override target still wins regardless of this flag.
   */
  private quietMode = false;

  constructor(config: Partial<GazeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_GAZE_CONFIG, ...config };
  }

  override reset(): void {
    this.posX = 0;
    this.posY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.nextSaccadeAt = 0;
    this.lastSampleAt = 0;
    this.override = null;
    this.defaultContactPref = null;
    this.quietMode = false;
  }

  setQuietMode(enabled: boolean): void {
    this.quietMode = enabled;
  }

  /**
   * Set the default gaze contact preference for the no-override path.
   *
   * - `null` — clears the preference; the layer reverts to its original
   *   pure-OU behaviour with no directional bias.
   * - `1`    — biased toward camera-center (no avoidant offset).
   * - `0`    — avoidant / downward default (full {@link AVOIDANT_Y_OFFSET}).
   * - Values between 0 and 1 linearly interpolate the offset.
   *
   * Explicit overrides via {@link setGazeTarget} are unaffected by this
   * setting — the override path always wins.
   *
   * Called by {@link PersonaPostureLayer} when the user pushes a
   * `gazeContactPreference` bias; not intended to be called directly by
   * AvatarService consumers.
   */
  setDefaultContactPreference(pref: number | null): void {
    this.defaultContactPref = pref !== null ? Math.max(0, Math.min(1, pref)) : null;
  }

  setGazeTarget(target: GazeTarget | null): void {
    if (target === null || target.type === 'clear') {
      this.override = null;
      return;
    }
    if (target.type === 'named') {
      const map: Record<typeof target.name, [number, number]> = {
        camera: [0, 0],
        center: [0, 0],
        left: [-0.7, 0],
        right: [0.7, 0],
        up: [0, -0.7],
        down: [0, 0.7],
      };
      const xy = map[target.name];
      this.override = { x: xy[0], y: xy[1] };
      return;
    }
    // point
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    this.override = { x: clamp(target.x), y: clamp(target.y) };
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    if (this.override) {
      // Explicit override always wins; defaultContactPref has no effect here.
      this.lastSampleAt = nowMs;
      return { 'eye.ball.x': this.override.x, 'eye.ball.y': this.override.y };
    }
    if (this.quietMode) {
      // Freeze: no OU drift, no saccades. Emits a still gaze so downstream
      // layers observe a stable baseline for the testing pass.
      this.lastSampleAt = nowMs;
      return { 'eye.ball.x': 0, 'eye.ball.y': 0 };
    }
    if (this.nextSaccadeAt === 0) this.nextSaccadeAt = nowMs + this.randomSaccadeInterval();

    // Saccade: pick a new target on the unit disk, biased toward center.
    if (nowMs >= this.nextSaccadeAt) {
      const r = this.config.maxRadius * Math.random() ** 2;
      const theta = Math.random() * 2 * Math.PI;
      this.targetX = r * Math.cos(theta);
      this.targetY = r * Math.sin(theta);
      this.nextSaccadeAt = nowMs + this.randomSaccadeInterval();
    }

    // OU step toward the current saccade target. Note: `theta` parameter is
    // tuned at ~60fps tick rate; we scale by the actual elapsed time so the
    // drift speed stays consistent if the compiler fps changes.
    //
    // `dt` is clamped to 100ms to defend against huge jumps after a pause —
    // the compiler is paused whenever there are no frame consumers, and on
    // resume the wall-clock gap can be arbitrarily large. An unclamped
    // `theta * (Δ/16.67)` would produce a single massive OU step that
    // overshoots the target on the first resumed frame.
    const rawDt = this.lastSampleAt === 0 ? 16.67 : nowMs - this.lastSampleAt;
    const dt = Math.min(rawDt, 100);
    const step = this.config.theta * (dt / 16.67);
    this.posX += step * (this.targetX - this.posX) + this.config.noiseSigma * gaussian();
    this.posY += step * (this.targetY - this.posY) + this.config.noiseSigma * gaussian();

    // Clamp to the unit disk (soft clamp by radius) to avoid corner-peg.
    const r = Math.hypot(this.posX, this.posY);
    if (r > this.config.maxRadius) {
      const k = this.config.maxRadius / r;
      this.posX *= k;
      this.posY *= k;
    }

    this.lastSampleAt = nowMs;

    // Apply the default contact preference bias as a deterministic additive
    // offset to the OU output. The override path already returned above, so
    // this block only runs when there is no explicit gaze target.
    //
    // pref=1 → avoidantOffset = 0   (camera-facing, no bias)
    // pref=0 → avoidantOffset = AVOIDANT_Y_OFFSET (downward / avoidant)
    // pref=null → avoidantOffset = 0 (original behaviour, no change)
    const avoidantOffset = this.defaultContactPref !== null ? (1 - this.defaultContactPref) * AVOIDANT_Y_OFFSET : 0;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    return { 'eye.ball.x': this.posX, 'eye.ball.y': clamp(this.posY + avoidantOffset) };
  }

  private randomSaccadeInterval(): number {
    const { saccadeIntervalMin: lo, saccadeIntervalMax: hi } = this.config;
    return lo + Math.random() * Math.max(0, hi - lo);
  }
}

/** Box-Muller Gaussian sample, mean 0, stddev 1. */
function gaussian(): number {
  const u = Math.max(Math.random(), Number.EPSILON);
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
