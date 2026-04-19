import type { BotState } from '../../state/types';
import { BaseLayer } from './BaseLayer';

/**
 * Live2D-style auto blink, modeled on Cubism's built-in `CubismEyeBlink` —
 * a 4-phase state machine (open → closing → closed → opening → open) timed
 * to match natural human blink cadence (~2-8 s between blinks, ~280ms total
 * close-open duration split across the phases).
 *
 * Emission semantics: this layer is **authoritative** for `eye.open.left/right`
 * baseline — it always emits `1 - closure` in [0, 1] every tick, including
 * during the `open` phase (where closure=0, so it emits 1). Reasons:
 *
 * 1. Emitting only during blink phases would let the compiler's low-pass
 *    smoothing ramp from prev=0 (channel dropped during `open`) up toward
 *    the blink curve over several ticks, visibly muddying the blink
 *    timing.
 *
 * 2. A continuously-emitted "1" baseline means the renderer sees a stable
 *    `ParamEyeLOpen = 1` when no one else is driving it, same as its
 *    moc3 default — so no visual change in idle, but blinks start cleanly
 *    from the correct open value.
 *
 * Consequence: discrete actions that want to change eye openness (e.g.
 * `thinking` → half-lidded, `angry` → narrowed) author their `eye.open.*`
 * targets as **deltas from 1.0** (negative values), since the compiler mixes
 * layer + action contributions additively. See default-action-map.json.
 */
interface BlinkConfig {
  /** Minimum wait between blinks in open state (ms). */
  intervalMin: number;
  /** Maximum wait between blinks in open state (ms). */
  intervalMax: number;
  /** Duration of the closing ramp (eyes: 1 → 0) in ms. */
  closingMs: number;
  /** Duration the eyes stay fully closed in ms. */
  closedMs: number;
  /** Duration of the opening ramp (eyes: 0 → 1) in ms. */
  openingMs: number;
}

const DEFAULT_BLINK_CONFIG: BlinkConfig = {
  intervalMin: 2000,
  intervalMax: 8000,
  closingMs: 80,
  closedMs: 60,
  openingMs: 140,
};

type BlinkPhase = 'open' | 'closing' | 'closed' | 'opening';

export class AutoBlinkLayer extends BaseLayer {
  readonly id = 'auto-blink';

  private readonly config: BlinkConfig;
  private phase: BlinkPhase = 'open';
  private phaseStartMs = 0;
  /** Timestamp at which the next blink should start (wall-clock ms). */
  private nextBlinkAt = 0;

  constructor(config: Partial<BlinkConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BLINK_CONFIG, ...config };
  }

  override reset(): void {
    this.phase = 'open';
    this.phaseStartMs = 0;
    this.nextBlinkAt = 0;
  }

  sample(nowMs: number, _state: BotState): Record<string, number> {
    void _state;
    // First-run: schedule the first blink lazily so we don't depend on a
    // constructor `now` reference (tests/mocks can move the clock).
    if (this.nextBlinkAt === 0) this.nextBlinkAt = nowMs + this.randomInterval();

    const closure = this.advanceAndSampleClosure(nowMs);
    const open = 1 - closure;
    return { 'eye.open.left': open, 'eye.open.right': open };
  }

  /**
   * Progress the phase timer and return `closure` in [0, 1] where 0 = eyes
   * fully open, 1 = fully closed. Transitions between phases happen here; the
   * return value is always the freshly-advanced state.
   */
  private advanceAndSampleClosure(nowMs: number): number {
    if (this.phase === 'open') {
      if (nowMs < this.nextBlinkAt) return 0;
      this.enterPhase('closing', nowMs);
    }

    const { closingMs, closedMs, openingMs } = this.config;
    const elapsed = nowMs - this.phaseStartMs;

    switch (this.phase) {
      case 'closing':
        if (elapsed >= closingMs) {
          this.enterPhase('closed', nowMs);
          return 1;
        }
        return Math.min(1, elapsed / closingMs);
      case 'closed':
        if (elapsed >= closedMs) {
          this.enterPhase('opening', nowMs);
          return 1;
        }
        return 1;
      case 'opening':
        if (elapsed >= openingMs) {
          this.phase = 'open';
          this.nextBlinkAt = nowMs + this.randomInterval();
          return 0;
        }
        return Math.max(0, 1 - elapsed / openingMs);
      default:
        return 0;
    }
  }

  private enterPhase(next: Exclude<BlinkPhase, 'open'>, nowMs: number): void {
    this.phase = next;
    this.phaseStartMs = nowMs;
  }

  private randomInterval(): number {
    const { intervalMin: lo, intervalMax: hi } = this.config;
    return lo + Math.random() * Math.max(0, hi - lo);
  }
}
