import { EventEmitter } from 'node:events';
import { IDLE_ANIMATIONS, TRANSITION_ANIMATIONS } from './idle-animations';
import { type BotState, DEFAULT_IDLE_CONFIG, type IdleConfig, type StateNodeOutput } from './types';

/**
 * Manages the bot's 5 display states. Emits `idle-animation` events
 * at random intervals (idleIntervalMin..idleIntervalMax) while in idle,
 * and returns the corresponding StateNode list via transition() during
 * state transitions.
 *
 * Events:
 *   - `'idle-animation'`: (nodes: StateNodeOutput[])
 *   - `'state-change'`  : (from: BotState, to: BotState)
 */
export class IdleStateMachine extends EventEmitter {
  private state: BotState = 'idle';
  private readonly config: IdleConfig;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(config?: Partial<IdleConfig>) {
    super();
    this.config = { ...DEFAULT_IDLE_CONFIG, ...(config ?? {}) };
  }

  get currentState(): BotState {
    return this.state;
  }

  /**
   * Triggers state transition, returns the list of transition animation nodes
   * for the new state.
   * - Entering idle: restarts the random idle timer
   * - Leaving idle: cancels the idle timer
   */
  transition(newState: BotState): StateNodeOutput[] {
    const prev = this.state;
    this.state = newState;

    if (prev !== newState) {
      this.emit('state-change', prev, newState);
    }

    if (newState === 'idle') {
      if (this.started) this.scheduleNextIdle();
    } else {
      this.clearIdleTimer();
    }

    // Deep copy (with timestamp) to prevent external modification of shared object
    const now = Date.now();
    return TRANSITION_ANIMATIONS[newState].map((n) => ({ ...n, timestamp: now }));
  }

  /** Starts the random idle animation timer (only actually schedules when in idle state) */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.state === 'idle') this.scheduleNextIdle();
  }

  /** Stops the idle animation timer */
  stop(): void {
    this.started = false;
    this.clearIdleTimer();
  }

  // ---- internals ----

  private scheduleNextIdle(): void {
    this.clearIdleTimer();
    const { idleIntervalMin: lo, idleIntervalMax: hi } = this.config;
    const delay = lo + Math.random() * Math.max(0, hi - lo);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Timer may have expired after leaving idle; check again
      if (!this.started || this.state !== 'idle') return;
      const pick = IDLE_ANIMATIONS[Math.floor(Math.random() * IDLE_ANIMATIONS.length)];
      const node: StateNodeOutput = { ...pick, timestamp: Date.now() };
      this.emit('idle-animation', [node]);
      // After animation ends, randomly schedule the next one (setTimeout, not setInterval)
      this.scheduleNextIdle();
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
