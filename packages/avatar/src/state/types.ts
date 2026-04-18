export type BotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reacting';

/**
 * Custom defined in this module, structure consistent with StateNode in src/avatar/compiler/types.ts.
 * Do not import compiler types to avoid circular dependency —— integration ticket will unify types.
 */
export interface StateNodeOutput {
  action: string;
  emotion: string;
  intensity: number;
  /** Milliseconds. 0 means continuous until next state change (used for thinking). */
  duration: number;
  delay?: number;
  easing: string;
  timestamp?: number;
}

export interface IdleConfig {
  /** Lower bound of random idle animation interval (ms), default 3000 */
  idleIntervalMin: number;
  /** Upper bound of random idle animation interval (ms), default 8000 */
  idleIntervalMax: number;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  idleIntervalMin: 3000,
  idleIntervalMax: 8000,
};
