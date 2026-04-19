import type { AvatarActivity } from '../../state/types';
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

export class EyeGazeLayer extends BaseLayer {
  readonly id = 'eye-gaze';

  private readonly config: GazeConfig;
  private posX = 0;
  private posY = 0;
  private targetX = 0;
  private targetY = 0;
  private nextSaccadeAt = 0;
  private lastSampleAt = 0;

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
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
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
    return { 'eye.ball.x': this.posX, 'eye.ball.y': this.posY };
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
