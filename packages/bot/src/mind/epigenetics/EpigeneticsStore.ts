// EpigeneticsStore — synchronous bun:sqlite persistence for Mind Phase 2.
//
// ## Constructor / instantiation pattern
//
// This class is NOT DI-decorated. It follows the same pattern as
// MemoryFactMetaService: the constructor accepts a raw bun:sqlite `Database`
// directly, which keeps tests simple (each test provides its own isolated DB)
// and allows production code to obtain the instance through duck-typed raw-DB
// access.
//
// ### Production wiring (example for Phase 2/3 consumers):
//
//   const adapter = databaseManager.getAdapter() as unknown as {
//     getRawDb?: () => import('bun:sqlite').Database | null;
//   };
//   if (typeof adapter.getRawDb === 'function') {
//     const rawDb = adapter.getRawDb();
//     if (rawDb) {
//       const epigeneticsStore = new EpigeneticsStore(rawDb);
//       container.register(DITokens.EPIGENETICS_STORE, { useValue: epigeneticsStore });
//     }
//   }
//
// This pattern is identical to how ConversationInitializer wires up
// MemoryFactMetaService. Adding DITokens.EPIGENETICS_STORE is a Phase 2 task.
//
// All public methods are async (future-proof for pooled DB adapters) but
// internally all bun:sqlite calls are synchronous.

import type { Database } from 'bun:sqlite';
import type {
  PersonaEpigenetics,
  PersonaReflection,
  PersonaRelationship,
  ReflectionPatch,
  TraitHistoryEntry,
  TraitKey,
} from './types';

/** Maximum cumulative signed delta per trait key within a 24-hour window. */
const TRAIT_BOUND_24H = 0.1;
/** Duration of the trait-history sliding window in milliseconds. */
const TRAIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── Raw DB row shapes ────────────────────────────────────────────────────────

interface EpigeneticsRow {
  persona_id: string;
  topic_mastery_json: string;
  behavioral_biases_json: string;
  learned_preferences_json: string;
  forbidden_words_json: string;
  forbidden_topics_json: string;
  trait_history_json: string;
  updated_at: number;
}

interface RelationshipRow {
  persona_id: string;
  user_id: string;
  affinity: number;
  familiarity: number;
  last_interaction_at: number;
  tags_json: string;
  shared_memory_refs_json: string;
  extra_json: string;
  updated_at: number;
}

interface ReflectionRow {
  id: number;
  persona_id: string;
  timestamp: number;
  trigger: string;
  insight_md: string;
  applied_patch_json: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Append items to an array without introducing duplicates. */
function appendUnique(existing: string[], additions: string[]): string[] {
  const set = new Set(existing);
  for (const item of additions) {
    set.add(item);
  }
  return Array.from(set);
}

function deserializeEpigenetics(row: EpigeneticsRow): PersonaEpigenetics {
  return {
    personaId: row.persona_id,
    topicMastery: JSON.parse(row.topic_mastery_json) as Record<string, number>,
    behavioralBiases: JSON.parse(row.behavioral_biases_json) as Record<string, number>,
    learnedPreferences: JSON.parse(row.learned_preferences_json) as Record<string, unknown>,
    forbiddenWords: JSON.parse(row.forbidden_words_json) as string[],
    forbiddenTopics: JSON.parse(row.forbidden_topics_json) as string[],
    traitHistory: JSON.parse(row.trait_history_json) as TraitHistoryEntry[],
    updatedAt: row.updated_at,
  };
}

function deserializeRelationship(row: RelationshipRow): PersonaRelationship {
  return {
    personaId: row.persona_id,
    userId: row.user_id,
    affinity: row.affinity,
    familiarity: row.familiarity,
    lastInteractionAt: row.last_interaction_at,
    tags: JSON.parse(row.tags_json) as string[],
    sharedMemoryRefs: JSON.parse(row.shared_memory_refs_json) as string[],
    extra: JSON.parse(row.extra_json) as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
}

function deserializeReflection(row: ReflectionRow): PersonaReflection {
  return {
    id: row.id,
    personaId: row.persona_id,
    timestamp: row.timestamp,
    trigger: row.trigger as PersonaReflection['trigger'],
    insightMd: row.insight_md,
    appliedPatch: JSON.parse(row.applied_patch_json) as ReflectionPatch,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class EpigeneticsStore {
  constructor(private readonly db: Database) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getEpigenetics(personaId: string): Promise<PersonaEpigenetics | null> {
    const row = this.db
      .query<EpigeneticsRow, [string]>('SELECT * FROM persona_epigenetics WHERE persona_id = ?')
      .get(personaId);
    if (!row) {
      return null;
    }
    return deserializeEpigenetics(row);
  }

  async getRelationship(personaId: string, userId: string): Promise<PersonaRelationship | null> {
    const row = this.db
      .query<RelationshipRow, [string, string]>(
        'SELECT * FROM persona_relationships WHERE persona_id = ? AND user_id = ?',
      )
      .get(personaId, userId);
    if (!row) {
      return null;
    }
    return deserializeRelationship(row);
  }

  async listRelationships(
    personaId: string,
    opts?: { limit?: number; orderBy?: 'affinity' | 'familiarity' },
  ): Promise<PersonaRelationship[]> {
    const orderCol = opts?.orderBy === 'familiarity' ? 'familiarity' : 'affinity';
    const limit = opts?.limit != null && opts.limit > 0 ? opts.limit : 100;
    const rows = this.db
      .query<RelationshipRow, [string]>(
        `SELECT * FROM persona_relationships WHERE persona_id = ? ORDER BY ${orderCol} DESC LIMIT ${limit}`,
      )
      .all(personaId);
    return rows.map(deserializeRelationship);
  }

  async getRecentReflections(personaId: string, limit: number): Promise<PersonaReflection[]> {
    const rows = this.db
      .query<ReflectionRow, [string]>(
        `SELECT * FROM persona_reflections WHERE persona_id = ? ORDER BY timestamp DESC LIMIT ${Math.max(1, limit)}`,
      )
      .all(personaId);
    return rows.map(deserializeReflection);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Apply a reflection patch to the epigenetics state for a persona.
   *
   * Trait bound: for each trait key, the sum of signed delta values stored in
   * the last 24-hour window plus the incoming delta must not exceed 0.1.
   * If any key violates the bound, the entire patch is rejected and nothing is
   * written to the DB.
   *
   * The epigenetics update and the reflection log insert are wrapped in a
   * single SQLite transaction so they are atomic.
   */
  async applyReflectionPatch(
    personaId: string,
    patch: ReflectionPatch,
    insight: { trigger: 'time' | 'event' | 'manual'; insightMd: string },
  ): Promise<{ accepted: boolean; rejectedReason?: string; reflectionId?: number }> {
    const now = Date.now();
    const windowStart = now - TRAIT_WINDOW_MS;

    // Load or initialise epigenetics state.
    const existing = await this.getEpigenetics(personaId);
    const state: PersonaEpigenetics = existing ?? {
      personaId,
      topicMastery: {},
      behavioralBiases: {},
      learnedPreferences: {},
      forbiddenWords: [],
      forbiddenTopics: [],
      traitHistory: [],
      updatedAt: now,
    };

    // Prune trait history to the 24 h window.
    const prunedHistory = state.traitHistory.filter((e) => e.ts >= windowStart);

    // Trait bound check.
    if (patch.traitDeltas) {
      for (const [key, delta] of Object.entries(patch.traitDeltas) as [TraitKey, number][]) {
        if (delta === undefined) {
          continue;
        }
        const windowSum = prunedHistory.reduce((acc, entry) => {
          const v = entry.traitDeltas[key];
          return acc + (typeof v === 'number' ? v : 0);
        }, 0);
        if (windowSum + delta > TRAIT_BOUND_24H) {
          return { accepted: false, rejectedReason: `trait_bound_exceeded:${key}` };
        }
      }
    }

    // Build updated state (all mutations are applied in this closure).
    const newTopicMastery = { ...state.topicMastery };
    if (patch.topicMasteryDelta) {
      for (const [topic, delta] of Object.entries(patch.topicMasteryDelta)) {
        newTopicMastery[topic] = clamp((newTopicMastery[topic] ?? 0) + delta, 0, 1);
      }
    }

    const newBehavioralBiases = { ...state.behavioralBiases };
    if (patch.behavioralBiasesDelta) {
      for (const [key, delta] of Object.entries(patch.behavioralBiasesDelta)) {
        newBehavioralBiases[key] = (newBehavioralBiases[key] ?? 0) + delta;
      }
    }

    // learnedPreferencesAdd: upsert semantics — new keys are set, existing keys overwritten.
    const newLearnedPreferences: Record<string, unknown> = { ...state.learnedPreferences };
    if (patch.learnedPreferencesAdd) {
      for (const [key, value] of Object.entries(patch.learnedPreferencesAdd)) {
        newLearnedPreferences[key] = value;
      }
    }

    const newForbiddenWords = patch.forbiddenWordsAdd
      ? appendUnique(state.forbiddenWords, patch.forbiddenWordsAdd)
      : state.forbiddenWords;

    const newForbiddenTopics = patch.forbiddenTopicsAdd
      ? appendUnique(state.forbiddenTopics, patch.forbiddenTopicsAdd)
      : state.forbiddenTopics;

    // Append the new trait-history entry (only if traitDeltas present) and prune.
    let newTraitHistory = prunedHistory;
    if (patch.traitDeltas && Object.keys(patch.traitDeltas).length > 0) {
      newTraitHistory = [...prunedHistory, { ts: now, traitDeltas: patch.traitDeltas }];
    }

    // Perform DB writes atomically.
    let reflectionId: number | undefined;
    const doWrite = this.db.transaction(() => {
      // Upsert epigenetics row.
      this.db
        .query(
          `INSERT INTO persona_epigenetics (
            persona_id, topic_mastery_json, behavioral_biases_json,
            learned_preferences_json, forbidden_words_json, forbidden_topics_json,
            trait_history_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(persona_id) DO UPDATE SET
            topic_mastery_json = excluded.topic_mastery_json,
            behavioral_biases_json = excluded.behavioral_biases_json,
            learned_preferences_json = excluded.learned_preferences_json,
            forbidden_words_json = excluded.forbidden_words_json,
            forbidden_topics_json = excluded.forbidden_topics_json,
            trait_history_json = excluded.trait_history_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          personaId,
          JSON.stringify(newTopicMastery),
          JSON.stringify(newBehavioralBiases),
          JSON.stringify(newLearnedPreferences),
          JSON.stringify(newForbiddenWords),
          JSON.stringify(newForbiddenTopics),
          JSON.stringify(newTraitHistory),
          now,
        );

      // Insert reflection log row.
      const result = this.db
        .query(
          `INSERT INTO persona_reflections (persona_id, timestamp, trigger, insight_md, applied_patch_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(personaId, now, insight.trigger, insight.insightMd, JSON.stringify(patch));

      return (result as { lastInsertRowid: number | bigint }).lastInsertRowid;
    });

    const lastId = doWrite() as number | bigint;
    reflectionId = typeof lastId === 'bigint' ? Number(lastId) : lastId;

    return { accepted: true, reflectionId };
  }

  /**
   * Increment relationship scores between a persona and a user.
   * Creates the row if it does not exist.
   * affinity is clamped to [-1, 1]; familiarity is clamped to [0, 1].
   */
  async bumpRelationship(
    personaId: string,
    userId: string,
    delta: {
      affinityDelta?: number;
      familiarityDelta?: number;
      tagAdd?: string[];
      sharedMemoryRefAdd?: string[];
    },
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.getRelationship(personaId, userId);

    const base: PersonaRelationship = existing ?? {
      personaId,
      userId,
      affinity: 0,
      familiarity: 0,
      lastInteractionAt: now,
      tags: [],
      sharedMemoryRefs: [],
      extra: {},
      updatedAt: now,
    };

    const newAffinity = clamp(base.affinity + (delta.affinityDelta ?? 0), -1, 1);
    const newFamiliarity = clamp(base.familiarity + (delta.familiarityDelta ?? 0), 0, 1);
    const newTags = delta.tagAdd ? appendUnique(base.tags, delta.tagAdd) : base.tags;
    const newRefs = delta.sharedMemoryRefAdd
      ? appendUnique(base.sharedMemoryRefs, delta.sharedMemoryRefAdd)
      : base.sharedMemoryRefs;

    this.db
      .query(
        `INSERT INTO persona_relationships (
          persona_id, user_id, affinity, familiarity,
          last_interaction_at, tags_json, shared_memory_refs_json, extra_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(persona_id, user_id) DO UPDATE SET
          affinity = excluded.affinity,
          familiarity = excluded.familiarity,
          last_interaction_at = excluded.last_interaction_at,
          tags_json = excluded.tags_json,
          shared_memory_refs_json = excluded.shared_memory_refs_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        personaId,
        userId,
        newAffinity,
        newFamiliarity,
        now,
        JSON.stringify(newTags),
        JSON.stringify(newRefs),
        JSON.stringify(base.extra),
        now,
      );
  }
}
