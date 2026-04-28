/**
 * WanderScheduler — drives autonomous idle behaviour on the avatar.
 *
 * Every ~`intervalMinMs..intervalMaxMs` (jittered) the scheduler runs a
 * single tick. On each tick it asks the gate predicate whether wandering
 * is currently allowed; if so it picks an intent and executes it
 * asynchronously. A new intent cannot start until the previous one has
 * finished (or been aborted externally).
 *
 * Intentionally a plain class with explicit deps — no DI, no singleton —
 * so the scheduler can be tested by injecting a fake executor + clock.
 */

import { logger } from '@/utils/logger';
import type { WanderConfig } from '../types';
import { executeIntent, getIntentFootprint, pickIntent } from './intents';
import type { WanderExecutor, WanderIntent } from './types';

export interface WanderSchedulerOptions {
  /** Deterministic RNG for intent sampling; defaults to `Math.random`. */
  rng?: () => number;
  /**
   * Sleep adapter used inside intent execution for `wait` steps. Tests
   * pass a no-op or a fake-timer resolver.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Clock source, for cooldown measurement. */
  now?: () => number;
  /** setTimeout adapter — tests can swap for sync / fake-timer variant. */
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class WanderScheduler {
  private readonly rng: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private running = false;
  private lastCompletedAt = 0;

  constructor(
    private readonly config: WanderConfig,
    private readonly executor: WanderExecutor,
    opts: WanderSchedulerOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h));
  }

  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.info('[WanderScheduler] Disabled by config — not starting');
      return;
    }
    this.started = true;
    logger.info(
      `[WanderScheduler] Started | interval=${this.config.intervalMinMs}-${this.config.intervalMaxMs}ms cooldown=${this.config.cooldownMs}ms`,
    );
    this.scheduleNext();
  }

  stop(): void {
    if (!this.started) return;
    if (this.timerHandle) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.started = false;
    logger.info('[WanderScheduler] Stopped');
  }

  /**
   * Fire one tick immediately, bypassing the timer. Returns the promise
   * representing intent execution (or `null` if the gate rejected). Used
   * by tests; production calls `start()` and lets the timer drive ticks.
   */
  async tickOnce(): Promise<WanderIntent | null> {
    if (!this.gateOpen()) return null;
    const intent = pickIntent(this.config, this.rng);
    // Footprint gate — a picked intent is skipped when its channel set
    // collides with active discrete animations. No retry / alternative
    // pick: intents are small and the next timer tick picks again. Keeping
    // it drop-on-conflict also keeps the test matrix small.
    const footprint = getIntentFootprint(intent);
    const conflicts = this.executor.checkAvailable(footprint);
    if (conflicts.size > 0) {
      logger.debug(`[WanderScheduler] intent=${intent.label} dropped — channels busy: ${[...conflicts].join(',')}`);
      return null;
    }
    this.running = true;
    try {
      await executeIntent(intent, this.executor, this.sleep);
      return intent;
    } finally {
      this.running = false;
      this.lastCompletedAt = this.now();
    }
  }

  /** Test helper — current gate state for assertions. */
  isRunning(): boolean {
    return this.running;
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const delay = this.pickDelay();
    this.timerHandle = this.setTimeoutFn(() => this.fire(), delay);
  }

  private async fire(): Promise<void> {
    this.timerHandle = null;
    if (!this.gateOpen()) {
      this.scheduleNext();
      return;
    }
    const intent = pickIntent(this.config, this.rng);
    // Footprint gate — see `tickOnce` for rationale on drop-without-retry.
    const footprint = getIntentFootprint(intent);
    const conflicts = this.executor.checkAvailable(footprint);
    if (conflicts.size > 0) {
      logger.debug(`[WanderScheduler] intent=${intent.label} dropped — channels busy: ${[...conflicts].join(',')}`);
      this.scheduleNext();
      return;
    }
    try {
      this.running = true;
      logger.info(`[WanderScheduler] intent=${intent.label} steps=${intent.steps.length}`);
      await executeIntent(intent, this.executor, this.sleep);
    } catch (err) {
      logger.warn(`[WanderScheduler] intent execution failed (non-fatal): ${err}`);
    } finally {
      this.running = false;
      this.lastCompletedAt = this.now();
      this.scheduleNext();
    }
  }

  /**
   * Gate predicate — `true` means a new wander intent is allowed *right
   * now*. Checked both before firing (in `fire`) and after each executed
   * intent (via cooldown). Gates are deliberately conservative:
   *
   *  - avatar must be active (otherwise all motion calls no-op anyway)
   *  - pose must be 'neutral' (listening/thinking/speaking all suppress
   *    autonomous motion so the bot doesn't move while it's engaged)
   *  - another intent must not already be running
   *  - cooldown since last completion must have elapsed
   */
  private gateOpen(): boolean {
    const reason = this.gateBlockReason();
    if (reason) {
      // Debug-level so production logs stay quiet; set LOG_LEVEL=debug to see why
      // wander is not firing when you expect it to.
      logger.debug(`[WanderScheduler] gate closed: ${reason}`);
      return false;
    }
    return true;
  }

  private gateBlockReason(): string | null {
    if (!this.started) return 'not-started';
    if (!this.config.enabled) return 'disabled-by-config';
    if (this.running) return 'intent-in-flight';
    if (!this.executor.isAvatarActive()) return 'avatar-not-active';
    // Skip when no renderer is connected: the compiler tick is paused and
    // every enqueued autonomous animation would just be dropped by the
    // dedup pass. Saves CPU + keeps logs quiet during idle hours.
    if (!this.executor.hasConsumer()) return 'no-consumer';
    const pose = this.executor.getCurrentPose();
    if (pose !== 'neutral') return `pose-is-${pose}`;
    const cooldownLeft = this.config.cooldownMs - (this.now() - this.lastCompletedAt);
    if (cooldownLeft > 0) return `cooldown-${cooldownLeft}ms-remaining`;
    return null;
  }

  private pickDelay(): number {
    const { intervalMinMs, intervalMaxMs } = this.config;
    const lo = Math.min(intervalMinMs, intervalMaxMs);
    const hi = Math.max(intervalMinMs, intervalMaxMs);
    return Math.round(lo + this.rng() * (hi - lo));
  }
}
