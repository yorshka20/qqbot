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
 * 2. **Saccades** — every 3-10s, pick a new random target according to the
 *    active {@link GazeDistribution} (camera / side / down / target kinds).
 *    OU process then drifts toward that target over the next few hundred ms,
 *    producing the characteristic "sudden jump, then hold" rhythm of human gaze.
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
 * Probability distribution over saccade target kinds.
 *
 * All fields are optional and default to 0. The layer normalises the weights
 * internally so only relative magnitudes matter. If all weights sum to 0 (or
 * the distribution is `null`) the layer reverts to the vanilla OU disk
 * sampling path.
 */
export interface GazeDistribution {
  /** Weight for saccading to camera (eye contact). Default 0. */
  camera?: number;
  /** Weight for saccading off-camera left/right. Default 0. */
  side?: number;
  /** Weight for saccading downward (averted gaze). Default 0. */
  down?: number;
  /** Reserved for future explicit-target use; falls back to camera in this ticket. Default 0. */
  target?: number;
}

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
   * Normalized distribution over saccade target kinds. null = unset (vanilla OU disk sampling).
   *
   * This field only influences the no-override path. Explicit
   * `setGazeTarget()` calls always win regardless of this value.
   */
  private gazeDistribution: { camera: number; side: number; down: number; target: number } | null = null;

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
    this.gazeDistribution = null;
    this.quietMode = false;
  }

  setQuietMode(enabled: boolean): void {
    this.quietMode = enabled;
  }

  /**
   * Set a probability distribution over saccade target kinds.
   *
   * - `null` — clears the distribution; the layer reverts to its original
   *   pure-OU behaviour with no directional bias.
   * - Weights are non-negative clamped; if the sum is ≤ 0 the distribution
   *   is treated as null (vanilla path).
   *
   * Called by {@link PersonaPostureLayer} when the mind pushes a
   * `gazeDistribution` bias; not intended to be called directly by
   * AvatarService consumers.
   */
  setGazeDistribution(dist: GazeDistribution | null): void {
    if (dist === null) {
      this.gazeDistribution = null;
      return;
    }
    const camera = Math.max(0, dist.camera ?? 0);
    const side = Math.max(0, dist.side ?? 0);
    const down = Math.max(0, dist.down ?? 0);
    const target = Math.max(0, dist.target ?? 0);
    const sum = camera + side + down + target;
    if (sum <= 0) {
      this.gazeDistribution = null;
      return;
    }
    this.gazeDistribution = {
      camera: camera / sum,
      side: side / sum,
      down: down / sum,
      target: target / sum,
    };
  }

  /**
   * Back-compat shim — delegates to {@link setGazeDistribution}.
   *
   * - `null` — clears the preference; the layer reverts to its original
   *   pure-OU behaviour with no directional bias.
   * - `1`    — biased toward camera-center.
   * - `0`    — avoidant / side default.
   * - Values between 0 and 1 linearly interpolate.
   *
   * Explicit overrides via {@link setGazeTarget} are unaffected by this
   * setting — the override path always wins.
   *
   * Called by {@link PersonaPostureLayer} when the user pushes a
   * `gazeContactPreference` bias; not intended to be called directly by
   * AvatarService consumers.
   */
  setDefaultContactPreference(pref: number | null): void {
    if (pref === null) {
      this.setGazeDistribution(null);
      return;
    }
    const clamped = Math.max(0, Math.min(1, pref));
    this.setGazeDistribution({ camera: clamped, side: 1 - clamped, down: 0 });
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
    //                    The original OU + periodic saccade + gaze-distribution path.
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
      // Saccade: pick a new target using the active gaze distribution, or vanilla disk.
      if (nowMs >= this.nextSaccadeAt) {
        const cap = this.config.maxRadius; // 0.6
        if (this.gazeDistribution) {
          const r = Math.random();
          const d = this.gazeDistribution;
          let kind: 'camera' | 'side' | 'down' | 'target';
          if (r < d.camera) kind = 'camera';
          else if (r < d.camera + d.side) kind = 'side';
          else if (r < d.camera + d.side + d.down) kind = 'down';
          else kind = 'target';

          switch (kind) {
            case 'camera': {
              const rr = cap * 0.15 * Math.random() ** 2;
              const a = Math.random() * 2 * Math.PI;
              this.targetX = rr * Math.cos(a);
              this.targetY = rr * Math.sin(a);
              break;
            }
            case 'side': {
              const sign = Math.random() < 0.5 ? -1 : 1;
              this.targetX = sign * (0.55 + 0.4 * Math.random()) * cap; // 0.55–0.95 of cap
              this.targetY = (Math.random() - 0.5) * 0.3 * cap;
              break;
            }
            case 'down': {
              this.targetY = (0.6 + 0.4 * Math.random()) * cap; // 0.6–1.0 of cap, downward
              this.targetX = (Math.random() - 0.5) * 0.3 * cap;
              break;
            }
            case 'target': {
              // No external target wired in this ticket — fall back to camera.
              this.targetX = 0;
              this.targetY = 0;
              break;
            }
          }
        } else {
          // Vanilla path: original disk sampling kept verbatim.
          const rr = cap * Math.random() ** 2;
          const a = Math.random() * 2 * Math.PI;
          this.targetX = rr * Math.cos(a);
          this.targetY = rr * Math.sin(a);
        }
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

    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    return { 'eye.ball.x': clamp(this.posX), 'eye.ball.y': clamp(this.posY) };
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
