// Mind Phase 2 epigenetics types — persistent persona state that evolves
// over time via reflection patches.

import type { Tone } from '../tone/types';

/** Big-Five trait keys used in EpigeneticsStore trait-bound enforcement. */
export type TraitKey = 'extraversion' | 'neuroticism' | 'openness' | 'agreeableness' | 'conscientiousness';

/** One entry in the sliding 24-hour trait-delta history. */
export interface TraitHistoryEntry {
  /** Unix timestamp (ms) when this patch was applied. */
  ts: number;
  /** The trait deltas recorded in this patch. */
  traitDeltas: Partial<Record<TraitKey, number>>;
}

/**
 * Persistent epigenetics state for a single persona.
 * Stored as a single row in `persona_epigenetics`.
 */
export interface PersonaEpigenetics {
  personaId: string;
  /** Topic name → mastery score in [0, 1]. Deltas are clamped on write. */
  topicMastery: Record<string, number>;
  /**
   * Behavioral bias keys → values.
   * Numeric entries are accumulated deltas (e.g. verbosity, humor).
   * String entries are discrete state values (e.g. currentTone).
   */
  behavioralBiases: Record<string, number | string>;
  /** Arbitrary learned preference keys → values of any shape. */
  learnedPreferences: Record<string, unknown>;
  /** Append-only set of forbidden words. No remove API. */
  forbiddenWords: string[];
  /** Append-only set of forbidden topics. No remove API. */
  forbiddenTopics: string[];
  /**
   * Sliding window of trait delta entries from the last 24 h.
   * Used to enforce per-trait cumulative change bounds.
   */
  traitHistory: TraitHistoryEntry[];
  /** Unix timestamp (ms) of the last write. */
  updatedAt: number;
}

/**
 * Relationship state between a persona and a specific user.
 * Stored as a row in `persona_relationships`.
 */
export interface PersonaRelationship {
  personaId: string;
  userId: string;
  /** Sentiment toward the user. Clamped to [-1, 1]. */
  affinity: number;
  /** How well the persona "knows" this user. Clamped to [0, 1]. */
  familiarity: number;
  /** Unix timestamp (ms) of the most recent interaction. */
  lastInteractionAt: number;
  /** Append-only set of relationship tags. */
  tags: string[];
  /** Append-only set of shared memory references. */
  sharedMemoryRefs: string[];
  /** Arbitrary extra data. */
  extra: Record<string, unknown>;
  /** Unix timestamp (ms) of the last write. */
  updatedAt: number;
}

/**
 * One reflection log entry stored in `persona_reflections`.
 * Append-only: rows are never deleted or updated.
 */
export interface PersonaReflection {
  id: number;
  personaId: string;
  /** Unix timestamp (ms) when the reflection was applied. */
  timestamp: number;
  trigger: 'time' | 'event' | 'manual';
  insightMd: string;
  /** The patch that was applied, serialized for audit / rollback. */
  appliedPatch: ReflectionPatch;
}

/**
 * A diff applied to `PersonaEpigenetics` by a reflection.
 * All fields are optional; only present keys are processed.
 */
export interface ReflectionPatch {
  /** Accumulate delta onto topicMastery[key], then clamp to [0, 1]. */
  topicMasteryDelta?: Record<string, number>;
  /** Per-trait deltas. Subject to 24 h cumulative bound of 0.1 per key. */
  traitDeltas?: Partial<Record<TraitKey, number>>;
  /** Words to append to the forbiddenWords list (no duplicates). */
  forbiddenWordsAdd?: string[];
  /** Topics to append to the forbiddenTopics list (no duplicates). */
  forbiddenTopicsAdd?: string[];
  /** Accumulate delta onto behavioralBiases[key]. Values must be numeric. */
  behavioralBiasesDelta?: Record<string, number>;
  /**
   * Set the current tone. Persisted under `behavioral_biases_json.currentTone`.
   * Separate from `behavioralBiasesDelta` so numeric accumulation stays clean.
   */
  currentTone?: Tone;
  /** Set or overwrite learned preference keys with arbitrary values. */
  learnedPreferencesAdd?: Record<string, unknown>;
}
