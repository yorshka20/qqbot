// Vector index of memory facts: one Qdrant collection per group, holding the active automatic
// facts and every manual line.
//
// The index is derived from its two sources and never read as content: an automatic point's id
// is its row's id (a UUID, which Qdrant keeps as is) and a manual point's id is its line's
// derived id, so every search hit maps straight back to the fact it came from. `source` tells
// the two apart, which lets one manual slot be reconciled without touching anything else.

import { inject, singleton } from 'tsyringe';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { RAGService } from '@/services/retrieval/rag/RAGService';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { coreScopeOf } from '../model/scopes';

/** Qwen3-Embedding query instruction; documents are embedded without one. */
const MEMORY_QUERY_PREFIX =
  'Instruct: Given a message in a group chat, retrieve remembered facts about its speaker or the group that help reply to it\nQuery: ';

export type MemorySource = 'auto' | 'manual';

export interface IndexedFact {
  id: string;
  groupId: string;
  userId: string;
  scope: string;
  content: string;
}

export interface SourcedFacts {
  auto: IndexedFact[];
  manual: IndexedFact[];
}

export interface MemorySearchHit {
  id: string;
  score: number;
}

/**
 * Whose facts a search covers: the group's own slot, every slot, every member slot but the
 * group's, or one member (with or without the group's slot).
 */
export type MemorySearchOwners = 'group' | 'everyone' | 'members' | { userId: string; includeGroup: boolean };

export interface MemorySearchOptions {
  owners: MemorySearchOwners;
  excludeCoreScopes: string[];
  limit: number;
  minScore: number;
}

@singleton()
export class MemoryIndex {
  private readonly rag: RAGService | null;

  constructor(@inject(RetrievalService) retrieval: RetrievalService) {
    this.rag = retrieval.getRAGService();
  }

  isEnabled(): boolean {
    return this.rag?.isEnabled() ?? false;
  }

  static collectionName(groupId: string): string {
    return `memory_${groupId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  async upsert(facts: IndexedFact[], source: MemorySource): Promise<void> {
    const rag = this.rag;
    if (!rag || facts.length === 0) {
      return;
    }
    for (const [groupId, groupFacts] of groupByGroup(facts)) {
      await rag.upsertDocuments(
        MemoryIndex.collectionName(groupId),
        groupFacts.map((fact) => ({
          id: fact.id,
          content: fact.content,
          payload: {
            groupId: fact.groupId,
            userId: fact.userId,
            isGroupMemory: fact.userId === GROUP_MEMORY_USER_ID,
            scope: fact.scope,
            coreScope: coreScopeOf(fact.scope),
            source,
          },
        })),
      );
    }
  }

  async remove(groupId: string, ids: string[]): Promise<void> {
    if (!this.rag || ids.length === 0) {
      return;
    }
    await this.rag.deleteByIds(MemoryIndex.collectionName(groupId), ids);
  }

  async search(groupId: string, query: string, options: MemorySearchOptions): Promise<MemorySearchHit[]> {
    const rag = this.rag;
    if (!rag || !query.trim()) {
      return [];
    }
    const owner = ownerCondition(options.owners);
    const filter: Record<string, unknown> = { must: owner ? [owner] : [] };
    if (options.excludeCoreScopes.length > 0) {
      filter.must_not = [{ key: 'coreScope', match: { any: options.excludeCoreScopes } }];
    }
    const results = await rag.vectorSearch(MemoryIndex.collectionName(groupId), query, {
      limit: options.limit,
      minScore: options.minScore,
      filter,
      queryPrefix: MEMORY_QUERY_PREFIX,
    });
    return results.map((r) => ({ id: String(r.id), score: r.score }));
  }

  /**
   * Make a group's collection hold exactly `wanted`: upsert the facts missing, changed since
   * they were indexed, or embedded by another model; set `source` on points that lack it
   * without re-embedding them; delete every other point.
   */
  async reconcile(groupId: string, wanted: SourcedFacts): Promise<{ upserted: number; removed: number }> {
    return this.reconcilePoints(groupId, undefined, [
      ...wanted.auto.map((fact) => ({ fact, source: 'auto' as const })),
      ...wanted.manual.map((fact) => ({ fact, source: 'manual' as const })),
    ]);
  }

  /** Make one slot's manual points match `facts`, leaving every other point alone. */
  async reconcileManualSlot(
    groupId: string,
    userId: string,
    facts: IndexedFact[],
  ): Promise<{ upserted: number; removed: number }> {
    const filter = {
      must: [
        { key: 'userId', match: { value: userId } },
        { key: 'source', match: { value: 'manual' } },
      ],
    };
    return this.reconcilePoints(
      groupId,
      filter,
      facts.map((fact) => ({ fact, source: 'manual' as const })),
    );
  }

  private async reconcilePoints(
    groupId: string,
    filter: Record<string, unknown> | undefined,
    wanted: Array<{ fact: IndexedFact; source: MemorySource }>,
  ): Promise<{ upserted: number; removed: number }> {
    const rag = this.rag;
    if (!rag) {
      return { upserted: 0, removed: 0 };
    }
    const collection = MemoryIndex.collectionName(groupId);
    const indexed = new Map<string, Record<string, unknown>>();
    for await (const page of rag.scrollAll(collection, { limit: 500, withPayload: true, filter })) {
      for (const point of page) {
        indexed.set(String(point.id), point.payload);
      }
    }
    const stale: Record<MemorySource, IndexedFact[]> = { auto: [], manual: [] };
    const relabel: Record<MemorySource, string[]> = { auto: [], manual: [] };
    for (const { fact, source } of wanted) {
      const payload = indexed.get(fact.id);
      if (
        !payload ||
        payload.content !== fact.content ||
        payload.scope !== fact.scope ||
        payload.embedModel !== rag.embeddingModel
      ) {
        stale[source].push(fact);
      } else if (payload.source !== source) {
        relabel[source].push(fact.id);
      }
    }
    const wantedIds = new Set(wanted.map(({ fact }) => fact.id));
    const extra = [...indexed.keys()].filter((id) => !wantedIds.has(id));
    for (const source of ['auto', 'manual'] as const) {
      await this.upsert(stale[source], source);
      if (relabel[source].length > 0) {
        await rag.setPayload(collection, relabel[source], { source });
      }
    }
    await this.remove(groupId, extra);
    return { upserted: stale.auto.length + stale.manual.length, removed: extra.length };
  }
}

function ownerCondition(owners: MemorySearchOwners): Record<string, unknown> | null {
  if (owners === 'everyone') {
    return null;
  }
  if (owners === 'group' || owners === 'members') {
    return { key: 'isGroupMemory', match: { value: owners === 'group' } };
  }
  const member = { key: 'userId', match: { value: owners.userId } };
  return owners.includeGroup ? { should: [member, { key: 'isGroupMemory', match: { value: true } }] } : member;
}

function groupByGroup(facts: IndexedFact[]): Map<string, IndexedFact[]> {
  const byGroup = new Map<string, IndexedFact[]>();
  for (const fact of facts) {
    const list = byGroup.get(fact.groupId);
    if (list) {
      list.push(fact);
    } else {
      byGroup.set(fact.groupId, [fact]);
    }
  }
  return byGroup;
}
