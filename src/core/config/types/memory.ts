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
  /** Enable context-aware memory filtering (default: true) */
  enabled?: boolean;
  /** Scopes that are always included regardless of relevance (default: ['instruction', 'rule']) */
  alwaysIncludeScopes?: string[];
  /** Minimum keyword match score (0-1) to include a section (default: 0.1) */
  minRelevanceScore?: number;
}

export interface MemoryConfig {
  /** Directory for memory files (relative to cwd). Group memory: {dir}/{groupId}/_global_.txt, user: {dir}/{groupId}/{userId}.txt */
  dir?: string;
  /** Context-aware memory filtering options */
  filter?: MemoryFilterConfig;
}
