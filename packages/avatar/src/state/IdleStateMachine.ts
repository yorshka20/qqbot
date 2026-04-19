import { EventEmitter } from 'node:events';
import { TRANSITION_ANIMATIONS } from './transition-animations';
import type { BotState, StateNodeOutput } from './types';

/**
 * Tracks the bot's 5 display states and emits transition-animation nodes on
 * state changes. Continuous "idle life" (breath, blink, gaze, idle motion) is
 * produced by the `AnimationLayer` stack in the compiler — this state machine
 * no longer schedules random micro-actions.
 *
 * Events:
 *   - `'state-change'`: (from: BotState, to: BotState)
 *
 * Note: the class retains its name (`IdleStateMachine`) and file location for
 * minimal import churn; conceptually it's now just a "bot state tracker".
 */
export class IdleStateMachine extends EventEmitter {
  private state: BotState = 'idle';

  get currentState(): BotState {
    return this.state;
  }

  /**
   * Transition to a new bot state. Returns the list of transition animation
   * nodes the compiler should enqueue for this edge (possibly empty).
   */
  transition(newState: BotState): StateNodeOutput[] {
    const prev = this.state;
    this.state = newState;

    if (prev !== newState) {
      this.emit('state-change', prev, newState);
    }

    // Deep copy (with timestamp) to prevent external mutation of shared object.
    const now = Date.now();
    return TRANSITION_ANIMATIONS[newState].map((n) => ({ ...n, timestamp: now }));
  }

  /** No-op — retained for backward compatibility with AvatarService's lifecycle. */
  start(): void {}

  /** No-op — retained for backward compatibility with AvatarService's lifecycle. */
  stop(): void {}
}
