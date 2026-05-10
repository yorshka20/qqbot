// ReflectionEngine types — shared with other reflection module files.

export type ReflectionTrigger = 'time' | 'event' | 'manual';

/** Options for constructing a ReflectionEngine. */
export interface ReflectionEngineOptions {
  /** Persona ID to reflect on. */
  personaId: string;
  /** How often the timer fires (ms). Default: 5 min. */
  timerIntervalMs?: number;
  /**
   * Window width (ms) used to count "recent activity" before a timer-fired
   * reflection. Default: 5 min.
   */
  activityWindowMs?: number;
  /** Minimum number of messages in the activity window to proceed. Default: 3. */
  activityMinMessages?: number;
  /**
   * Minimum time (ms) between two reflections regardless of trigger.
   * Default: same as timerIntervalMs (5 min).
   */
  cooldownMs?: number;
  /** LLM provider name to pin to for reflection calls. Default: 'gemini'. */
  pinnedProvider?: string;
}
