// The read side of memory: what a reply carries, a whole slot, and search across a group.
//
// A reply carries every manual fact of the group and the speaker (they win any conflict), their
// automatic facts in the always-include scopes, and the automatic facts a vector search finds
// relevant to the message. Searched facts are reranked (scoring.ts) and must clear
// `memory.filter.minRelevanceScore`; each one that makes it into a reply counts a hit.

import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import type { MemoryFilterConfig, MemoryScoringConfig } from '@/core/config/types/memory';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { coreScopeOf } from '../model/scopes';
import { ManualMemoryStore } from '../storage/ManualMemoryStore';
import { MemoryFactStore } from '../storage/MemoryFactStore';
import { MemoryIndex, type MemorySearchOwners } from '../storage/MemoryIndex';
import { renderByScope, renderSlot } from './renderSlot';
import { DEFAULT_SCORING, scoreFact } from './scoring';

const DEFAULT_FILTER: Required<MemoryFilterConfig> = {
  alwaysIncludeScopes: ['instruction', 'rule'],
  minRelevanceScore: 0.47,
  count: 6,
};

export interface ReplyMemory {
  groupMemoryText: string;
  userMemoryText: string;
}

export interface MemorySearchResult {
  text: string;
  count: number;
}

@singleton()
export class MemoryRetrievalService {
  private readonly filter: Required<MemoryFilterConfig>;
  private readonly scoring: Required<MemoryScoringConfig>;

  constructor(
    @inject(DITokens.CONFIG) config: Config,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(MemoryIndex) private readonly index: MemoryIndex,
    @inject(ManualMemoryStore) private readonly manualStore: ManualMemoryStore,
  ) {
    const memoryConfig = config.getMemoryConfig();
    this.filter = { ...DEFAULT_FILTER, ...memoryConfig.filter };
    this.scoring = { ...DEFAULT_SCORING, ...memoryConfig.scoring };
  }

  isSearchEnabled(): boolean {
    return this.index.isEnabled();
  }

  getScoring(): Required<MemoryScoringConfig> {
    return this.scoring;
  }

  /**
   * Memory for one reply: every manual fact of the group and the speaker, their automatic facts
   * in the always-include scopes, and the other automatic facts relevant to `query`.
   */
  async getMemoryForReply(groupId: string, userId: string | undefined, query: string): Promise<ReplyMemory> {
    const groupAuto = await this.store.listSlot(groupId, GROUP_MEMORY_USER_ID, 'active');
    const userAuto = userId ? await this.store.listSlot(groupId, userId, 'active') : [];
    const always = (fact: MemoryFact) =>
      this.filter.alwaysIncludeScopes.includes(fact.scope) ||
      this.filter.alwaysIncludeScopes.includes(coreScopeOf(fact.scope));

    const searched = await this.searchRelevant(groupId, userId, query, [...groupAuto, ...userAuto]);
    const pick = (slotFacts: MemoryFact[]) => slotFacts.filter((fact) => always(fact) || searched.has(fact.id));

    return {
      groupMemoryText: renderSlot(this.manualStore.getFacts(groupId, GROUP_MEMORY_USER_ID), pick(groupAuto)),
      userMemoryText: userId ? renderSlot(this.manualStore.getFacts(groupId, userId), pick(userAuto)) : '',
    };
  }

  /**
   * Ids of the non-always-include facts relevant to `query`. Without a vector index every
   * fact counts as relevant, so the reply carries the whole slot.
   */
  private async searchRelevant(
    groupId: string,
    userId: string | undefined,
    query: string,
    candidates: MemoryFact[],
  ): Promise<Set<string>> {
    if (!this.index.isEnabled()) {
      return new Set(candidates.map((fact) => fact.id));
    }
    if (!query.trim() || candidates.length === 0) {
      return new Set();
    }
    const owners: MemorySearchOwners = userId ? { userId, includeGroup: true } : 'group';
    const ranked = await this.rank(groupId, query, owners, this.filter.count, this.coreAlwaysScopes(), candidates);
    const ids = ranked.map((r) => r.fact.id);
    this.store.recordHits(ids, Date.now()).catch((err) => {
      logger.warn('[MemoryRetrievalService] hit count write failed:', err);
    });
    return new Set(ids);
  }

  private coreAlwaysScopes(): string[] {
    return this.filter.alwaysIncludeScopes.filter((scope) => !scope.includes(':'));
  }

  private async rank(
    groupId: string,
    query: string,
    owners: MemorySearchOwners,
    count: number,
    excludeCoreScopes: string[],
    candidates: MemoryFact[],
  ): Promise<Array<{ fact: MemoryFact; score: number }>> {
    const byId = new Map(candidates.map((fact) => [fact.id, fact]));
    const hits = await this.index.search(groupId, query, {
      owners,
      excludeCoreScopes,
      limit: count * 3,
      minScore: this.filter.minRelevanceScore / this.scoring.confirmBoostCap,
    });
    const now = Date.now();
    return hits
      .flatMap((hit) => {
        const fact = byId.get(hit.id);
        return fact ? [{ fact, score: scoreFact(hit.score, fact, this.scoring, now) }] : [];
      })
      .filter((r) => r.score >= this.filter.minRelevanceScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }

  /** A whole slot as text: every manual fact and every active automatic fact. */
  async getMemory(
    groupId: string,
    userId?: string,
  ): Promise<{ userId: string; isGroupMemory: boolean; content: string }> {
    const slotUserId = userId?.trim() ? userId.trim() : GROUP_MEMORY_USER_ID;
    const auto = await this.store.listSlot(groupId, slotUserId, 'active');
    return {
      userId: slotUserId,
      isGroupMemory: slotUserId === GROUP_MEMORY_USER_ID,
      content: renderSlot(this.manualStore.getFacts(groupId, slotUserId), auto),
    };
  }

  /**
   * Facts about `query` across the group: automatic facts by vector search (or substring match
   * without an index), manual facts by substring match.
   */
  async searchMemory(
    groupId: string,
    query: string,
    options: { userId?: string; includeGroupMemory: boolean; limit: number },
  ): Promise<MemorySearchResult> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { text: '', count: 0 };
    }
    const owns = (slotUserId: string) =>
      slotUserId === GROUP_MEMORY_USER_ID
        ? options.includeGroupMemory
        : !options.userId || slotUserId === options.userId;
    const active = (await this.store.listGroup(groupId, 'active')).filter((fact) => owns(fact.userId));

    let autoFacts: MemoryFact[];
    if (this.index.isEnabled()) {
      const owners: MemorySearchOwners = options.userId
        ? { userId: options.userId, includeGroup: options.includeGroupMemory }
        : options.includeGroupMemory
          ? 'everyone'
          : 'members';
      autoFacts = (await this.rank(groupId, query, owners, options.limit, [], active)).map((r) => r.fact);
    } else {
      autoFacts = active.filter((fact) => fact.content.toLowerCase().includes(needle)).slice(0, options.limit);
    }

    const bySlot = new Map<string, Array<{ scope: string; content: string }>>();
    const add = (slotUserId: string, fact: { scope: string; content: string }) => {
      const list = bySlot.get(slotUserId);
      if (list) {
        list.push(fact);
      } else {
        bySlot.set(slotUserId, [fact]);
      }
    };
    let count = 0;
    for (const slot of this.manualStore.listSlots()) {
      if (slot.groupId !== groupId || !owns(slot.userId)) {
        continue;
      }
      for (const fact of this.manualStore.getFacts(groupId, slot.userId)) {
        if (fact.content.toLowerCase().includes(needle)) {
          add(slot.userId, { scope: fact.scope, content: `${fact.content}（人工维护）` });
          count++;
        }
      }
    }
    for (const fact of autoFacts) {
      add(fact.userId, fact);
      count++;
    }
    const text = [...bySlot.entries()]
      .map(([slotUserId, facts]) => {
        const label = slotUserId === GROUP_MEMORY_USER_ID ? '群记忆' : `用户 ${slotUserId} 的记忆`;
        return `${label}:\n${renderByScope(facts)}`;
      })
      .join('\n\n');
    return { text, count };
  }
}
