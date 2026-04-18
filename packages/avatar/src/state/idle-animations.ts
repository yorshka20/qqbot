import type { BotState, StateNodeOutput } from './types';

/** Micro-actions randomly selected and played during idle state (at least 3 types) */
export const IDLE_ANIMATIONS: StateNodeOutput[] = [
  { action: 'blink', emotion: 'neutral', intensity: 1.0, duration: 300, easing: 'easeInOutCubic' },
  { action: 'head_sway', emotion: 'neutral', intensity: 0.8, duration: 3000, easing: 'easeInOutCubic' },
  { action: 'breathe', emotion: 'neutral', intensity: 0.5, duration: 4000, easing: 'easeInOutCubic' },
];

/**
 * Transition animations triggered by state changes.
 * - `* → idle`: empty array (handled by IdleStateMachine.start() timer)
 * - `* → listening`: lean_forward (intensity 0.3)
 * - `* → thinking`: thinking (intensity 0.6, duration=0 means continuous)
 * - `* → speaking`: empty array (driven by LLM tags)
 * - `* → reacting`: empty array (determined by event)
 */
export const TRANSITION_ANIMATIONS: Record<BotState, StateNodeOutput[]> = {
  idle: [],
  listening: [{ action: 'lean_forward', emotion: 'neutral', intensity: 0.3, duration: 500, easing: 'easeInOutCubic' }],
  thinking: [{ action: 'thinking', emotion: 'neutral', intensity: 0.6, duration: 0, easing: 'easeInOutCubic' }],
  speaking: [],
  reacting: [],
};
