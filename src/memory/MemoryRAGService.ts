// Memory RAG Service - vector-based semantic search for memory facts
// Enables context-aware memory filtering using embeddings instead of keyword matching
// Indexes at fact/sentence level for fine-grained retrieval
// Supports hierarchical scopes: [core_scope:subtag] format

import type { RAGService } from '@/services/retrieval/rag/RAGService';
import { logger } from '@/utils/logger';
import type { FactMeta, MemoryFactMetaService } from './MemoryFactMetaService';
import { MemoryFactMetaService as FactMetaServiceClass } from './MemoryFactMetaService';
import type { MemorySection } from './MemoryService';

/** Parsed scope components for hierarchical scopes */
interface ParsedScopeInfo {
  /** Core scope (e.g., 'preference' from 'preference:food') */
  core: string;
  /** Optional subtag (e.g., 'food' from 'preference:food') */
  subtag?: string;
  /** Full scope string */
  full: string;
}

/** A single fact/statement extracted from memory for fine-grained indexing */
export interface MemoryFact {
  /** Full scope string (e.g., 'preference:food' or 'identity') */
  scope: string;
  /** Core scope for filtering (e.g., 'preference') */
  coreScope: string;
  /** Optional subtag (e.g., 'food') */
  subtag?: string;
  /** The actual fact content (a single sentence/statement) */
  content: string;
  /** Index within the scope for stable ID generation */
  index: number;
}

/** Document structure for memory RAG indexing */
export interface MemoryRAGDocument {
  /** Unique ID: {groupId}_{userId}_{scope}_{index} */
  id: string;
  /** Fact content for embedding */
  content: string;
  /** Metadata for filtering and reconstruction */
  payload: {
    groupId: string;
    userId: string;
    /** Full scope string (e.g., 'preference:food') */
    scope: string;
    /** Core scope for filtering (e.g., 'preference') */
    coreScope: string;
    /** Optional subtag (e.g., 'food') */
    subtag?: string;
    isGroupMemory: boolean;
    /** Original fact content without scope prefix */
    factContent: string;
  };
}

/** Search result from memory RAG - returns individual facts */
export interface MemoryRAGSearchResult {
  /** The matched fact */
  fact: MemoryFact;
  /** Similarity score */
  score: number;
  /** User ID this fact belongs to */
  userId: string;
  /** Whether this is group memory */
  isGroupMemory: boolean;
  /** Qdrant point ID (factHash after Phase 3 migration) */
  pointId?: string;
}

/** Options for memory RAG search */
export interface MemoryRAGSearchOptions {
  /** Target user ID (for filtering user-specific memory) */
  userId?: string;
  /** Include group memory in search (default: true) */
  includeGroupMemory?: boolean;
  /** Maximum results to return (default: 10) */
  limit?: number;
  /** Minimum similarity score (default: 0.7) */
  minScore?: number;
}

/** Group memory user ID marker */
const GROUP_MEMORY_USER_ID = '_global_memory_';

/**
 * MemoryRAGService provides semantic search for memory facts.
 *
 * Architecture:
 * - One Qdrant collection per group: `memory_{groupId}`
 * - Each fact (sentence/statement) is a separate document for fine-grained retrieval
 * - Payload includes userId, scope, and original content for reconstruction
 *
 * Indexing granularity:
 * - Memory is split by [scope] sections first
 * - Each section is further split into individual facts (sentences)
 * - Each fact becomes a separate vector document
 *
 * This enables retrieving only the relevant facts instead of entire sections.
 */
export class MemoryRAGService {
  private factMetaService: MemoryFactMetaService | null = null;

  constructor(private ragService: RAGService) {
    logger.info('[MemoryRAGService] Initialized');
  }

  /**
   * Set the fact metadata service for incremental diff indexing.
   * When not set, falls back to delete-all + re-index behavior.
   */
  setFactMetaService(service: MemoryFactMetaService): void {
    this.factMetaService = service;
    logger.info('[MemoryRAGService] FactMetaService configured for incremental diff');
  }

  /**
   * Get collection name for a group's memory
   */
  private getCollectionName(groupId: string): string {
    const safeGroupId = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
    return `memory_${safeGroupId}`;
  }

  /**
   * Generate unique document ID for a memory fact
   */
  private generateFactId(groupId: string, userId: string, scope: string, index: number): string {
    const safeGroupId = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeUserId = userId.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeScope = scope.replace(/[^a-zA-Z0-9_]/g, '_');
    return `${safeGroupId}_${safeUserId}_${safeScope}_${index}`;
  }

  /**
   * Parse a scope string into hierarchical components.
   * Supports formats: 'core_scope' or 'core_scope:subtag'
   */
  private parseScope(scopeStr: string): ParsedScopeInfo {
    const normalized = scopeStr.trim().toLowerCase();
    const colonIndex = normalized.indexOf(':');

    if (colonIndex === -1) {
      return { core: normalized, full: normalized };
    }

    const core = normalized.slice(0, colonIndex);
    const subtag = normalized.slice(colonIndex + 1);
    return { core, subtag: subtag || undefined, full: normalized };
  }

  /**
   * Split section content into individual facts (sentences/statements).
   * Handles both Chinese and English text.
   * Includes parsed scope info for hierarchical scope support.
   */
  private splitIntoFacts(scope: string, content: string): MemoryFact[] {
    if (!content.trim()) {
      return [];
    }

    const parsedScope = this.parseScope(scope);

    // Split by sentence-ending punctuation (Chinese and English)
    // Preserves the punctuation with the sentence
    const sentences = content
      .split(/(?<=[。！？；.!?;])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // If no sentence breaks found, treat the whole content as one fact
    if (sentences.length === 0) {
      return [
        {
          scope: parsedScope.full,
          coreScope: parsedScope.core,
          subtag: parsedScope.subtag,
          content: content.trim(),
          index: 0,
        },
      ];
    }

    return sentences.map((sentence, index) => ({
      scope: parsedScope.full,
      coreScope: parsedScope.core,
      subtag: parsedScope.subtag,
      content: sentence,
      index,
    }));
  }

  /**
   * Delete all existing facts for a user (or group memory) from RAG.
   * Must be called before re-indexing to prevent orphan facts when fact count changes.
   */
  async deleteUserFacts(groupId: string, userId: string): Promise<void> {
    if (!this.ragService.isEnabled()) return;

    const collection = this.getCollectionName(groupId);
    const filter = {
      must: [
        { key: 'groupId', match: { value: groupId } },
        { key: 'userId', match: { value: userId } },
      ],
    };

    try {
      await this.ragService.deleteByFilter(collection, filter);
      logger.info(`[MemoryRAGService] Deleted existing facts for ${groupId}/${userId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[MemoryRAGService] Failed to delete old facts (may not exist yet):', err.message);
    }
  }

  /**
   * Index memory sections to RAG for a specific user or group.
   * Deletes old facts first to prevent orphans, then splits and indexes new facts.
   *
   * @param groupId - Group ID
   * @param userId - User ID (or GROUP_MEMORY_USER_ID for group memory)
   * @param sections - Parsed memory sections to index
   */
  async indexMemorySections(
    groupId: string,
    userId: string,
    sections: MemorySection[],
    source: 'manual' | 'llm_extract' = 'llm_extract',
    forceRebuild: boolean = false,
  ): Promise<void> {
    if (!this.ragService.isEnabled()) {
      logger.debug('[MemoryRAGService] RAG not enabled, skipping memory indexing');
      return;
    }

    if (sections.length === 0) {
      logger.debug(`[MemoryRAGService] No sections to index for ${groupId}/${userId}`);
      return;
    }

    const isGroupMemory = userId === GROUP_MEMORY_USER_ID;

    // Split all sections into individual facts
    const allFacts: MemoryFact[] = [];
    for (const section of sections) {
      const facts = this.splitIntoFacts(section.scope, section.content);
      allFacts.push(...facts);
    }

    if (allFacts.length === 0) {
      logger.debug(`[MemoryRAGService] No facts to index for ${groupId}/${userId}`);
      return;
    }

    // If no factMetaService, fall back to legacy delete-all + re-index
    if (!this.factMetaService) {
      await this.indexMemorySectionsLegacy(groupId, userId, allFacts, isGroupMemory);
      return;
    }

    // ── Incremental diff with SQLite metadata ──
    await this.indexMemorySectionsIncremental(groupId, userId, allFacts, isGroupMemory, source, forceRebuild);
  }

  /**
   * Legacy indexing: delete all facts for user, then re-index everything.
   * Used when MemoryFactMetaService is not available.
   */
  private async indexMemorySectionsLegacy(
    groupId: string,
    userId: string,
    allFacts: MemoryFact[],
    isGroupMemory: boolean,
  ): Promise<void> {
    const collection = this.getCollectionName(groupId);
    await this.deleteUserFacts(groupId, userId);

    const documents = allFacts.map((fact) => ({
      id: this.generateFactId(groupId, userId, fact.scope, fact.index),
      content: `[${fact.scope}] ${fact.content}`,
      payload: {
        groupId,
        userId,
        scope: fact.scope,
        coreScope: fact.coreScope,
        subtag: fact.subtag,
        isGroupMemory,
        factContent: fact.content,
        factIndex: fact.index,
      },
    }));

    try {
      await this.ragService.upsertDocuments(collection, documents);
      logger.info(
        `[MemoryRAGService] Indexed ${documents.length} facts (legacy) ` +
          `for ${isGroupMemory ? 'group' : 'user'} ${groupId}/${userId}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[MemoryRAGService] Failed to index memory facts (legacy):', err);
    }
  }

  /**
   * Incremental diff indexing using SQLite fact metadata.
   * Only inserts new facts and deletes orphans in Qdrant.
   */
  private async indexMemorySectionsIncremental(
    groupId: string,
    userId: string,
    allFacts: MemoryFact[],
    isGroupMemory: boolean,
    source: 'manual' | 'llm_extract',
    forceRebuild: boolean,
  ): Promise<void> {
    const collection = this.getCollectionName(groupId);
    const fms = this.factMetaService!;

    // 1. Compute content hashes for all new facts
    const newFactMap = new Map<string, MemoryFact>();
    for (const fact of allFacts) {
      const hash = FactMetaServiceClass.computeFactHash(groupId, userId, fact.scope, fact.content);
      newFactMap.set(hash, fact);
    }

    // 2. Load existing metadata from SQLite (same source only)
    const existingMeta = fms.getFactMeta(groupId, userId, source);

    // 3. Quick check: any changes?
    const newHashes = new Set(newFactMap.keys());
    const oldHashes = new Set(existingMeta.keys());
    const hasNew = [...newHashes].some((h) => !oldHashes.has(h));
    const hasRemoved = [...oldHashes].some((h) => !newHashes.has(h));

    if (!hasNew && !hasRemoved && !forceRebuild) {
      logger.debug(`[MemoryRAGService] No changes for ${groupId}/${userId} (${source}), skipping`);
      return;
    }

    // 4. SQLite reconcile: reinforce existing, insert new, mark orphans stale
    for (const [hash] of newFactMap) {
      if (existingMeta.has(hash)) {
        fms.reinforceFact(hash);
        const meta = existingMeta.get(hash)!;
        if (meta.status === 'stale') {
          fms.activateFact(hash);
        }
      } else {
        fms.insertFact({
          factHash: hash,
          groupId,
          userId,
          scope: newFactMap.get(hash)!.scope,
          source,
          firstSeen: Date.now(),
          lastReinforced: Date.now(),
          reinforceCount: 1,
        });
      }
    }

    // Orphan handling
    for (const [hash] of existingMeta) {
      if (!newHashes.has(hash)) {
        if (source === 'llm_extract') {
          fms.markStale(hash);
        } else {
          // manual: human removed it, hard delete
          fms.deleteFact(hash);
        }
      }
    }

    // 5. Qdrant diff: compute target set from all active facts
    const allActiveFacts = fms.getActiveFacts(groupId, userId);
    const targetHashes = new Set(allActiveFacts.map((f) => f.factHash));

    if (forceRebuild) {
      // Full rebuild: delete all, re-insert
      await this.deleteUserFacts(groupId, userId);
      const documents = this.buildDocumentsFromActive(allActiveFacts, newFactMap, groupId, userId, isGroupMemory);
      if (documents.length > 0) {
        await this.ragService.upsertDocuments(collection, documents);
      }
    } else {
      // Incremental: only add/remove changed points
      const existingPointIds = await this.getExistingPointIds(groupId, userId, collection);
      const toDelete = [...existingPointIds].filter((id) => !targetHashes.has(id));
      const toInsert = [...targetHashes].filter((id) => !existingPointIds.has(id));

      if (toDelete.length > 0) {
        try {
          await this.ragService.deleteByIds(collection, toDelete);
        } catch (err) {
          logger.warn('[MemoryRAGService] Failed to delete orphan points:', err);
        }
      }

      if (toInsert.length > 0) {
        const insertFactMap = new Map<string, MemoryFact>();
        for (const hash of toInsert) {
          const fact = newFactMap.get(hash);
          if (fact) insertFactMap.set(hash, fact);
        }
        const documents = this.buildDocumentsFromMap(insertFactMap, groupId, userId, isGroupMemory);
        if (documents.length > 0) {
          await this.ragService.upsertDocuments(collection, documents);
        }
      }
    }

    logger.info(
      `[MemoryRAGService] Reconciled ${source} facts for ${isGroupMemory ? 'group' : 'user'} ${groupId}/${userId}: ` +
        `${newFactMap.size} current, ${allActiveFacts.length} active total`,
    );
  }

  /**
   * Get existing Qdrant point IDs for a user (lightweight scroll, no vectors).
   */
  private async getExistingPointIds(groupId: string, userId: string, collection: string): Promise<Set<string>> {
    const filter = {
      must: [
        { key: 'groupId', match: { value: groupId } },
        { key: 'userId', match: { value: userId } },
      ],
    };
    try {
      const points = await this.ragService.scrollByFilter(collection, filter, { limit: 10000 });
      return new Set(points.map((p) => String(p.id)));
    } catch {
      return new Set();
    }
  }

  /**
   * Build Qdrant documents from active fact metadata + current facts.
   */
  private buildDocumentsFromActive(
    activeFacts: FactMeta[],
    factMap: Map<string, MemoryFact>,
    groupId: string,
    userId: string,
    isGroupMemory: boolean,
  ) {
    return activeFacts
      .map((meta) => {
        const fact = factMap.get(meta.factHash);
        if (!fact) return null;
        return {
          id: meta.factHash,
          content: `[${fact.scope}] ${fact.content}`,
          payload: {
            groupId,
            userId,
            scope: fact.scope,
            coreScope: fact.coreScope,
            subtag: fact.subtag,
            isGroupMemory,
            factContent: fact.content,
          },
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  }

  /**
   * Build Qdrant documents from a hash → fact map.
   */
  private buildDocumentsFromMap(
    factMap: Map<string, MemoryFact>,
    groupId: string,
    userId: string,
    isGroupMemory: boolean,
  ) {
    return [...factMap.entries()].map(([hash, fact]) => ({
      id: hash,
      content: `[${fact.scope}] ${fact.content}`,
      payload: {
        groupId,
        userId,
        scope: fact.scope,
        coreScope: fact.coreScope,
        subtag: fact.subtag,
        isGroupMemory,
        factContent: fact.content,
      },
    }));
  }

  /**
   * Search for relevant memory facts using semantic similarity.
   * Returns individual facts (sentences) rather than entire sections.
   *
   * @param groupId - Group ID to search within
   * @param query - User message or query for semantic matching
   * @param options - Search options
   * @returns Matching memory facts with scores
   */
  async searchRelevantFacts(
    groupId: string,
    query: string,
    options: MemoryRAGSearchOptions = {},
  ): Promise<MemoryRAGSearchResult[]> {
    if (!this.ragService.isEnabled()) {
      return [];
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const collection = this.getCollectionName(groupId);
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 0.7;
    const includeGroupMemory = options.includeGroupMemory !== false;

    // Build filter based on options
    const mustConditions: Array<Record<string, unknown>> = [];

    if (options.userId) {
      if (includeGroupMemory) {
        mustConditions.push({
          should: [
            { key: 'userId', match: { value: options.userId } },
            { key: 'isGroupMemory', match: { value: true } },
          ],
        });
      } else {
        mustConditions.push({
          key: 'userId',
          match: { value: options.userId },
        });
      }
    } else if (includeGroupMemory) {
      mustConditions.push({
        key: 'isGroupMemory',
        match: { value: true },
      });
    }

    const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

    try {
      const results = await this.ragService.vectorSearch(collection, trimmedQuery, {
        limit,
        minScore,
        filter,
      });

      return results.map((r) => {
        const scope = (r.payload?.scope as string) ?? 'unknown';
        const coreScope = (r.payload?.coreScope as string) ?? scope;
        return {
          fact: {
            scope,
            coreScope,
            subtag: r.payload?.subtag as string | undefined,
            content: (r.payload?.factContent as string) ?? '',
            index: (r.payload?.factIndex as number) ?? 0,
          },
          score: r.score,
          userId: (r.payload?.userId as string) ?? '',
          isGroupMemory: (r.payload?.isGroupMemory as boolean) ?? false,
          pointId: r.id != null ? String(r.id) : undefined,
        };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[MemoryRAGService] Search failed, returning empty results:', err.message);
      return [];
    }
  }

  /**
   * Group search results by scope for easier reconstruction.
   * Combines multiple facts from the same scope into a coherent text.
   */
  groupResultsByScope(results: MemoryRAGSearchResult[]): Map<string, { facts: string[]; isGroupMemory: boolean }> {
    const grouped = new Map<string, { facts: string[]; isGroupMemory: boolean }>();

    for (const result of results) {
      const key = `${result.userId}_${result.fact.scope}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.facts.push(result.fact.content);
      } else {
        grouped.set(key, {
          facts: [result.fact.content],
          isGroupMemory: result.isGroupMemory,
        });
      }
    }

    return grouped;
  }

  /**
   * Format search results as memory text for prompt injection.
   * Groups facts by scope and formats them appropriately.
   */
  formatResultsAsMemoryText(
    results: MemoryRAGSearchResult[],
    _options: { separateByUser?: boolean } = {},
  ): { groupMemoryText: string; userMemoryText: string } {
    const groupFacts: Map<string, string[]> = new Map();
    const userFacts: Map<string, string[]> = new Map();

    for (const result of results) {
      const targetMap = result.isGroupMemory ? groupFacts : userFacts;
      const existing = targetMap.get(result.fact.scope);
      if (existing) {
        existing.push(result.fact.content);
      } else {
        targetMap.set(result.fact.scope, [result.fact.content]);
      }
    }

    const formatMap = (map: Map<string, string[]>): string => {
      if (map.size === 0) return '';
      const sections: string[] = [];
      for (const [scope, facts] of map) {
        sections.push(`[${scope}]\n${facts.join(' ')}`);
      }
      return sections.join('\n\n');
    };

    return {
      groupMemoryText: formatMap(groupFacts),
      userMemoryText: formatMap(userFacts),
    };
  }

  /**
   * Fetch all facts for specific core scopes from RAG (no vector search, payload filter only).
   * Used for always-include scopes like 'instruction' and 'rule'.
   *
   * @param groupId - Group ID
   * @param coreScopes - Core scopes to fetch (e.g., ['instruction', 'rule'])
   * @param options - Optional userId filter
   * @returns Facts grouped by scope
   */
  async getFactsByCoreScopes(
    groupId: string,
    coreScopes: string[],
    options?: { userId?: string; includeGroupMemory?: boolean },
  ): Promise<MemoryRAGSearchResult[]> {
    if (!this.ragService.isEnabled() || coreScopes.length === 0) {
      return [];
    }

    const collection = this.getCollectionName(groupId);
    const includeGroupMemory = options?.includeGroupMemory !== false;

    // Build filter: must match one of the core scopes AND match user/group criteria
    const scopeConditions = coreScopes.map((scope) => ({
      key: 'coreScope',
      match: { value: scope },
    }));

    const mustConditions: Array<Record<string, unknown>> = [{ should: scopeConditions }];

    if (options?.userId) {
      if (includeGroupMemory) {
        mustConditions.push({
          should: [
            { key: 'userId', match: { value: options.userId } },
            { key: 'isGroupMemory', match: { value: true } },
          ],
        });
      } else {
        mustConditions.push({
          key: 'userId',
          match: { value: options.userId },
        });
      }
    }

    const filter = { must: mustConditions };

    try {
      const points = await this.ragService.scrollByFilter(collection, filter, { limit: 200 });

      return points.map((p) => {
        const scope = (p.payload?.scope as string) ?? 'unknown';
        const coreScope = (p.payload?.coreScope as string) ?? scope;
        return {
          fact: {
            scope,
            coreScope,
            subtag: p.payload?.subtag as string | undefined,
            content: (p.payload?.factContent as string) ?? '',
            index: (p.payload?.factIndex as number) ?? 0,
          },
          score: 1.0, // Always-include, so max score
          userId: (p.payload?.userId as string) ?? '',
          isGroupMemory: (p.payload?.isGroupMemory as boolean) ?? false,
          pointId: p.id != null ? String(p.id) : undefined,
        };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[MemoryRAGService] Failed to fetch facts by core scopes:', err.message);
      return [];
    }
  }

  /**
   * Check if RAG is available and enabled
   */
  isEnabled(): boolean {
    return this.ragService.isEnabled();
  }
}
