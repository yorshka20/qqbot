// Vector index of active automatic memory facts: one Qdrant collection per group.
//
// The index is derived from `memory_facts` and never read as content: a point's id is its
// fact's row id (a UUID, which Qdrant keeps as is), so every search hit maps straight back
// to the row. Only active facts are indexed. Manual memory is not indexed: it is injected
// in full on every reply.

import { inject, singleton } from 'tsyringe';
import type { MemoryFact } from '@/database/models/types';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { RAGService } from '@/services/retrieval/rag/RAGService';
import { coreScopeOf } from './manualMemory';
import { GROUP_MEMORY_USER_ID } from './memoryConstants';

/** Qwen3-Embedding query instruction; documents are embedded without one. */
const MEMORY_QUERY_PREFIX =
  'Instruct: Given a message in a group chat, retrieve remembered facts about its speaker or the group that help reply to it\nQuery: ';

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

  async upsert(facts: MemoryFact[]): Promise<void> {
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
   * Make a group's collection hold exactly `activeFacts`: upsert the ones missing, changed
   * since they were indexed, or embedded by another model; delete every other point.
   */
  async reconcile(groupId: string, activeFacts: MemoryFact[]): Promise<{ upserted: number; removed: number }> {
    const rag = this.rag;
    if (!rag) {
      return { upserted: 0, removed: 0 };
    }
    const collection = MemoryIndex.collectionName(groupId);
    const indexed = new Map<string, Record<string, unknown>>();
    for await (const page of rag.scrollAll(collection, { limit: 500, withPayload: true })) {
      for (const point of page) {
        indexed.set(String(point.id), point.payload);
      }
    }
    const wanted = new Map(activeFacts.map((fact) => [fact.id, fact]));
    const stale = activeFacts.filter((fact) => {
      const payload = indexed.get(fact.id);
      return (
        !payload ||
        payload.content !== fact.content ||
        payload.scope !== fact.scope ||
        payload.embedModel !== rag.embeddingModel
      );
    });
    const extra = [...indexed.keys()].filter((id) => !wanted.has(id));
    await this.upsert(stale);
    await this.remove(groupId, extra);
    return { upserted: stale.length, removed: extra.length };
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

function groupByGroup(facts: MemoryFact[]): Map<string, MemoryFact[]> {
  const byGroup = new Map<string, MemoryFact[]>();
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
