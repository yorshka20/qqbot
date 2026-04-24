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
  /** OU mean-reversion strength per tick (0..1) for the autonomous no-override path.
   *  Higher = snappier. Tuned for slow biological-looking drift between saccades. */
  theta: number;
  /** OU theta used while an explicit override target is active (setGazeTarget or quietMode
   *  recovery). Much higher than `theta` so the eye converges on the override target in
   *  ~100-200 ms — fast enough to read as a deliberate glance but smooth enough to avoid
   *  the pop-to-target "teleport" the old hard-override path produced. */
  overrideTheta: number;
  /** Gaussian noise stddev per tick (normalized units). Suppressed on the override / quiet
   *  paths so deliberate gaze doesn't jitter. */
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
  // 0.25 @ 60 fps ≈ 6.2 ms time constant × ~15 frames to 98 % convergence ≈ 167 ms total.
  // Human saccade duration is ~20–200 ms depending on amplitude; this sits in the
  // middle of that range which reads as "quick but not instant".
  overrideTheta: 0.25,
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
    // Unified OU-drift model: the eye position always drifts toward a target with a
    // per-path theta. Three scenarios share one integration step:
    //
    //   1. override    — target = override.{x,y},  theta = overrideTheta, no noise.
    //                    Explicit deliberate gaze (setGazeTarget / wander glance /
    //                    LLM [G:] tag). Previously snapped; now converges in ~150–200 ms
    //                    for a natural fast-saccade feel instead of a teleport.
    //   2. quietMode   — target = (0, 0),          theta = overrideTheta, no noise.
    //                    Debug / test mode: eye drifts to camera centre and holds,
    //                    producing a stable still baseline.
    //   3. autonomous  — target = saccade target,  theta = config.theta,  + Gaussian noise.
    //                    The original OU + periodic saccade + gaze-avoidance path.
    //
    // `dt` is clamped to 100 ms to defend against pause/resume wall-clock gaps — the
    // compiler pauses when no one is reading frames, and resume otherwise produces a
    // single massive step that overshoots.
    const rawDt = this.lastSampleAt === 0 ? 16.67 : nowMs - this.lastSampleAt;
    const dt = Math.min(rawDt, 100);
    this.lastSampleAt = nowMs;

    let tx: number;
    let ty: number;
    let effectiveTheta: number;
    let addNoise: boolean;

    if (this.override) {
      tx = this.override.x;
      ty = this.override.y;
      effectiveTheta = this.config.overrideTheta;
      addNoise = false;
    } else if (this.quietMode) {
      tx = 0;
      ty = 0;
      effectiveTheta = this.config.overrideTheta;
      addNoise = false;
    } else {
      if (this.nextSaccadeAt === 0) this.nextSaccadeAt = nowMs + this.randomSaccadeInterval();
      // Saccade: pick a new target on the unit disk, biased toward centre.
      if (nowMs >= this.nextSaccadeAt) {
        const r = this.config.maxRadius * Math.random() ** 2;
        const a = Math.random() * 2 * Math.PI;
        this.targetX = r * Math.cos(a);
        this.targetY = r * Math.sin(a);
        this.nextSaccadeAt = nowMs + this.randomSaccadeInterval();
      }
      tx = this.targetX;
      ty = this.targetY;
      effectiveTheta = this.config.theta;
      addNoise = true;
    }

    const step = effectiveTheta * (dt / 16.67);
    this.posX += step * (tx - this.posX) + (addNoise ? this.config.noiseSigma * gaussian() : 0);
    this.posY += step * (ty - this.posY) + (addNoise ? this.config.noiseSigma * gaussian() : 0);

    // maxRadius clamp keeps the autonomous wander within a natural gaze region, but it
    // must NOT apply to override / quiet paths — the caller asked for a specific target
    // (named 'left'/'right' etc map to ±0.7, outside the 0.6 autonomous disk) and
    // clamping here would silently override their intent. The hard [-1, 1] clamp below
    // still runs to keep the output within the eye-ball channel's valid range.
    if (!this.override && !this.quietMode) {
      const r = Math.hypot(this.posX, this.posY);
      if (r > this.config.maxRadius) {
        const k = this.config.maxRadius / r;
        this.posX *= k;
        this.posY *= k;
      }
    }

    // Overrides and quiet-mode bypass the default contact-preference bias — deliberate
    // gaze should land exactly where the caller asked. Only the autonomous path applies
    // the avoidant offset.
    if (this.override || this.quietMode) {
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      return { 'eye.ball.x': clamp(this.posX), 'eye.ball.y': clamp(this.posY) };
    }

    // pref=1 → avoidantOffset = 0 (camera-facing); pref=0 → full AVOIDANT_Y_OFFSET;
    // pref=null (unset) → 0 (pure OU behaviour, original contract).
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
