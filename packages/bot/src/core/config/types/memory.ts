// Memory (plugin) configuration - file-based persistence path

/**
 * Core scope types for user memory.
 * These are the primary categories for organizing user-specific facts.
 * Subtags can be freely added (e.g., preference:food, preference:music).
 */
export const USER_CORE_SCOPES = [
  'identity',
  'preference',
  'opinion',
  'relationship',
  'behavior',
  'instruction',
] as const;
export type UserCoreScope = (typeof USER_CORE_SCOPES)[number];

/**
 * Core scope types for group memory.
 * These are the primary categories for organizing group-level facts.
 */
export const GROUP_CORE_SCOPES = ['topic', 'rule', 'event', 'context'] as const;
export type GroupCoreScope = (typeof GROUP_CORE_SCOPES)[number];

/** All core scopes (user + group) */
export const ALL_CORE_SCOPES = [...USER_CORE_SCOPES, ...GROUP_CORE_SCOPES] as const;
export type CoreScope = UserCoreScope | GroupCoreScope;

/**
 * Parsed hierarchical scope: [core_scope:subtag] or [core_scope]
 */
export interface ParsedScope {
  /** The core scope category (e.g., 'preference', 'identity') */
  core: string;
  /** Optional subtag for fine-grained categorization (e.g., 'food', 'music') */
  subtag?: string;
  /** Full scope string as it appears in memory (e.g., 'preference:food') */
  full: string;
}

export interface MemoryFilterConfig {
  /** Core scopes whose facts every reply carries in full, regardless of the message. Default: instruction, rule. */
  alwaysIncludeScopes?: string[];
  /** Minimum final score (similarity x recency x confirmation) for a searched fact. Default 0.55. */
  minRelevanceScore?: number;
  /** Searched facts per reply, across the group and the speaker. Default 6. */
  count?: number;
}

/** Reranking of searched facts. Manual memory is not searched: it is always injected in full. */
export interface MemoryScoringConfig {
  /** Half-life in days of a transient fact's weight, counted from its last confirmation. Default 30. Stable facts do not decay. */
  transientHalfLifeDays?: number;
  /** Floor of that decay. Default 0.5. */
  decayFloor?: number;
  /** Weight added per confirmation beyond the first. Default 0.03. */
  confirmBoostPerConfirm?: number;
  /** Cap of the confirmation weight. Default 1.3. */
  confirmBoostCap?: number;
}

/** When an active fact is due for an LLM review that keeps, retires or merges it. */
export interface MemoryReviewConfig {
  /** A transient fact unconfirmed and unreviewed this many days is due. Default 30. */
  transientAfterDays?: number;
  /** A stable fact unconfirmed and unreviewed this many days is due. Default 180. */
  stableAfterDays?: number;
}

export interface MemoryConfig {
  /** Directory for manual memory files (relative to cwd): {dir}/{groupId}/{userId|_global_}/manual.txt */
  dir?: string;
  filter?: MemoryFilterConfig;
  scoring?: MemoryScoringConfig;
  review?: MemoryReviewConfig;
}
