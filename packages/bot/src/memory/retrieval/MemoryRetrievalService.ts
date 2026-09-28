// The read side of memory: what a reply carries, a whole slot, and search across a group.
//
// A group reply carries the group's and the speaker's facts in the always-include scopes, and the
// other facts a vector search finds relevant to the message. Manual and automatic facts are
// selected the same way; a manual fact ranks as fully confirmed, and the reply lists the manual
// ones first as winning any conflict. Searched facts are reranked (scoring.ts) and must clear
// `memory.filter.minRelevanceScore`; each automatic one that makes it into a reply counts a hit.
// A private reply carries the person's own memory from every group, and no group's memory.

import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import type { MemoryFilterConfig, MemoryScoringConfig } from '@/core/config/types/memory';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { coreScopeOf } from '../model/scopes';
import { type ManualMemoryFact, ManualMemoryStore } from '../storage/ManualMemoryStore';
import { MemoryFactStore } from '../storage/MemoryFactStore';
import { MemoryIndex, type MemorySearchOwners } from '../storage/MemoryIndex';
import { renderByScope, renderSlot } from './renderSlot';
import { DEFAULT_SCORING, scoreFact, scoreManualFact } from './scoring';

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

interface Candidates {
  auto: MemoryFact[];
  manual: ManualMemoryFact[];
}

type FoundFact = { source: 'auto'; fact: MemoryFact } | { source: 'manual'; fact: ManualMemoryFact };

type RankedFact = FoundFact & { score: number };

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
   * Memory for one group reply: the group's and the speaker's facts in the always-include
   * scopes, and their other facts relevant to `query`.
   */
  async getMemoryForReply(groupId: string, userId: string | undefined, query: string): Promise<ReplyMemory> {
    const groupAuto = await this.store.listSlot(groupId, GROUP_MEMORY_USER_ID, 'active');
    const userAuto = userId ? await this.store.listSlot(groupId, userId, 'active') : [];
    const groupManual = this.manualStore.getFacts(groupId, GROUP_MEMORY_USER_ID);
    const userManual = userId ? this.manualStore.getFacts(groupId, userId) : [];
    const owners: MemorySearchOwners = userId ? { userId, includeGroup: true } : 'group';
    const searched = await this.searchRelevant([groupId], owners, query, {
      auto: [...groupAuto, ...userAuto],
      manual: [...groupManual, ...userManual],
    });
    const pick = <T extends MemoryFact | ManualMemoryFact>(facts: T[]) => this.pick(facts, searched);

    return {
      groupMemoryText: renderSlot(pick(groupManual), pick(groupAuto)),
      userMemoryText: userId ? renderSlot(pick(userManual), pick(userAuto)) : '',
    };
  }

  /**
   * Memory for one private-chat reply: the person's own memory from every group they have it
   * in, selected the same way as in a group. No group's own memory: group rules and group
   * context belong to that group's chat. A fact kept in more than one group appears once.
   */
  async getMemoryForPrivateReply(userId: string, query: string): Promise<string> {
    const auto = await this.store.listUserFacts(userId, 'active');
    const manual = this.manualStore
      .listSlots()
      .filter((slot) => slot.userId === userId)
      .flatMap((slot) => this.manualStore.getFacts(slot.groupId, userId));
    const groupIds = [...new Set([...auto, ...manual].map((fact) => fact.groupId))];
    const searched = await this.searchRelevant(groupIds, { userId, includeGroup: false }, query, { auto, manual });
    return renderSlot(uniqueByContent(this.pick(manual, searched)), uniqueByContent(this.pick(auto, searched)));
  }

  private pick<T extends MemoryFact | ManualMemoryFact>(facts: T[], searched: Set<string>): T[] {
    return facts.filter((fact) => this.isAlwaysIncluded(fact.scope) || searched.has(fact.id));
  }

  private isAlwaysIncluded(scope: string): boolean {
    return (
      this.filter.alwaysIncludeScopes.includes(scope) || this.filter.alwaysIncludeScopes.includes(coreScopeOf(scope))
    );
  }

  /**
   * Ids of the non-always-include facts relevant to `query`, searched in each group and ranked
   * together; each automatic one counts a hit. Without a vector index every fact counts as
   * relevant, so the reply carries every candidate.
   */
  private async searchRelevant(
    groupIds: string[],
    owners: MemorySearchOwners,
    query: string,
    candidates: Candidates,
  ): Promise<Set<string>> {
    const all = [...candidates.auto, ...candidates.manual];
    if (!this.index.isEnabled()) {
      return new Set(all.map((fact) => fact.id));
    }
    if (!query.trim() || all.length === 0) {
      return new Set();
    }
    const ranked = await this.rank(groupIds, query, owners, this.filter.count, this.coreAlwaysScopes(), candidates);
    const autoIds = ranked.flatMap((r) => (r.source === 'auto' ? [r.fact.id] : []));
    this.store.recordHits(autoIds, Date.now()).catch((err) => {
      logger.warn('[MemoryRetrievalService] hit count write failed:', err);
    });
    return new Set(ranked.map((r) => r.fact.id));
  }

  private coreAlwaysScopes(): string[] {
    return this.filter.alwaysIncludeScopes.filter((scope) => !scope.includes(':'));
  }

  private async rank(
    groupIds: string[],
    query: string,
    owners: MemorySearchOwners,
    count: number,
    excludeCoreScopes: string[],
    candidates: Candidates,
  ): Promise<RankedFact[]> {
    const auto = new Map(candidates.auto.map((fact) => [fact.id, fact]));
    const manual = new Map(candidates.manual.map((fact) => [fact.id, fact]));
    const options = {
      owners,
      excludeCoreScopes,
      limit: count * 3,
      minScore: this.filter.minRelevanceScore / this.scoring.confirmBoostCap,
    };
    const hits = (await Promise.all(groupIds.map((groupId) => this.index.search(groupId, query, options)))).flat();
    const now = Date.now();
    return hits
      .flatMap((hit): RankedFact[] => {
        const autoFact = auto.get(hit.id);
        if (autoFact) {
          return [{ source: 'auto', fact: autoFact, score: scoreFact(hit.score, autoFact, this.scoring, now) }];
        }
        const manualFact = manual.get(hit.id);
        return manualFact
          ? [{ source: 'manual', fact: manualFact, score: scoreManualFact(hit.score, this.scoring) }]
          : [];
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
   * Facts about `query` across the group, manual and automatic alike: by vector search, or by
   * substring match without an index.
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
    const candidates: Candidates = {
      auto: (await this.store.listGroup(groupId, 'active')).filter((fact) => owns(fact.userId)),
      manual: this.manualStore
        .listSlots()
        .filter((slot) => slot.groupId === groupId && owns(slot.userId))
        .flatMap((slot) => this.manualStore.getFacts(groupId, slot.userId)),
    };

    let found: FoundFact[];
    if (this.index.isEnabled()) {
      const owners: MemorySearchOwners = options.userId
        ? { userId: options.userId, includeGroup: options.includeGroupMemory }
        : options.includeGroupMemory
          ? 'everyone'
          : 'members';
      found = await this.rank([groupId], query, owners, options.limit, [], candidates);
    } else {
      const matches = (fact: { content: string }) => fact.content.toLowerCase().includes(needle);
      found = [
        ...candidates.manual.filter(matches).map((fact): FoundFact => ({ source: 'manual', fact })),
        ...candidates.auto.filter(matches).map((fact): FoundFact => ({ source: 'auto', fact })),
      ].slice(0, options.limit);
    }

    const bySlot = new Map<string, Array<{ scope: string; content: string }>>();
    for (const { source, fact } of found) {
      const entry = { scope: fact.scope, content: source === 'manual' ? `${fact.content}（人工维护）` : fact.content };
      const list = bySlot.get(fact.userId);
      if (list) {
        list.push(entry);
      } else {
        bySlot.set(fact.userId, [entry]);
      }
    }
    const text = [...bySlot.entries()]
      .map(([slotUserId, facts]) => {
        const label = slotUserId === GROUP_MEMORY_USER_ID ? '群记忆' : `用户 ${slotUserId} 的记忆`;
        return `${label}:\n${renderByScope(facts)}`;
      })
      .join('\n\n');
    return { text, count: found.length };
  }
}

function uniqueByContent<T extends { content: string }>(facts: T[]): T[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (seen.has(fact.content)) {
      return false;
    }
    seen.add(fact.content);
    return true;
  });
}
