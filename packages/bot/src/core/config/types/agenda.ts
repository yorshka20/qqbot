// Agenda configuration - limits for LLM-registered agenda items (schedule_task / watch_messages)

/**
 * Hard limits applied to agenda items created by the LLM itself.
 * All values are enforced server-side in AgendaService.createLlmItem;
 * LLM-supplied parameters are clamped or rejected against these bounds.
 */
export interface AgendaLlmLimits {
  /** Max live LLM-created items per group */
  maxLiveItemsPerGroup: number;
  /** Max live LLM-created items across all conversations */
  maxLiveItemsGlobal: number;
  /** Default TTL for onMessage watches when the LLM omits one */
  defaultTtlMs: number;
  /** Upper bound for TTL / once-task horizon */
  maxTtlMs: number;
  /** Lower bound for once-task delay */
  minDelayMs: number;
  /** Default fire budget for onMessage watches */
  defaultMaxFires: number;
  /** Upper bound for fire budget */
  maxFiresCap: number;
  /** Lower bound for cooldown between fires of one item */
  minCooldownMs: number;
  /** Max self-scheduling chain depth (agenda run creating further items) */
  maxChainDepth: number;
  /** Max keywords per watch */
  maxKeywords: number;
  /** Min length of a single keyword (chars) */
  keywordMinLength: number;
  /** Max length of a single keyword (chars) */
  keywordMaxLength: number;
  /** Max send_message calls per LLM loop run */
  maxSendsPerRun: number;
}

export const DEFAULT_AGENDA_LLM_LIMITS: AgendaLlmLimits = {
  maxLiveItemsPerGroup: 20,
  maxLiveItemsGlobal: 100,
  defaultTtlMs: 24 * 3600_000,
  maxTtlMs: 72 * 3600_000,
  minDelayMs: 30_000,
  defaultMaxFires: 1,
  maxFiresCap: 100,
  minCooldownMs: 5_000,
  maxChainDepth: 3,
  maxKeywords: 5,
  keywordMinLength: 2,
  keywordMaxLength: 20,
  maxSendsPerRun: 5,
};

export interface AgendaConfig {
  /** Overrides for LLM-created item limits */
  llmLimits?: Partial<AgendaLlmLimits>;
}
