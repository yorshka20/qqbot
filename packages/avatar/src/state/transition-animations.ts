import type { BotState, StateNodeOutput } from './types';

/**
 * Discrete animations triggered by bot-state transitions. Each entry is the
 * list of state nodes enqueued the moment the state changes to `<key>`.
 *
 * - `* → idle`: empty — idle "life" is now produced continuously by the
 *   animation layer stack (breath / blink / gaze / idle-motion), not by a
 *   scheduler picking discrete micro-actions.
 * - `* → listening`: subtle lean-forward to signal attention.
 * - `* → thinking`: continuous thinking pose (duration=0 = hold until next
 *   state change — the compiler's ADSR treats 0 duration as instant attack
 *   then indefinite sustain).
 * - `* → speaking`: empty (LLM tag output drives speaking animations).
 * - `* → reacting`: empty (caller decides the reaction animation).
 */
export const TRANSITION_ANIMATIONS: Record<BotState, StateNodeOutput[]> = {
  idle: [],
  listening: [{ action: 'lean_forward', emotion: 'neutral', intensity: 0.3, duration: 500, easing: 'easeInOutCubic' }],
  thinking: [{ action: 'thinking', emotion: 'neutral', intensity: 0.6, duration: 0, easing: 'easeInOutCubic' }],
  speaking: [],
  reacting: [],
};
