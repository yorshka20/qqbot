// Memory reads, and the hand-written layer.
//
// Two sources, one per layer:
//   manual — data/memory/{groupId}/{userId|_global_}/manual.txt, written by people (webui or
//            editor), never by an LLM. Injected in full on every reply; it wins any conflict.
//   auto   — `memory_facts` rows (MemoryFactStore), written by consolidation and review.
//            A reply carries the always-include scopes in full plus the facts a vector
//            search finds relevant to the message.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import type { MemoryFilterConfig, MemoryScoringConfig } from '@/core/config/types/memory';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { MemoryFactStore } from './MemoryFactStore';
import { MemoryIndex, type MemorySearchOwners } from './MemoryIndex';
import { coreScopeOf, type ManualFact, parseManualFacts } from './manualMemory';
import { GROUP_MEMORY_USER_ID } from './memoryConstants';

export { GROUP_MEMORY_USER_ID } from './memoryConstants';

const DEFAULT_MEMORY_DIR = 'data/memory';
const GROUP_MEMORY_DIRNAME = '_global_';
const MANUAL_FILENAME = 'manual.txt';

const DEFAULT_FILTER: Required<MemoryFilterConfig> = {
  alwaysIncludeScopes: ['instruction', 'rule'],
  minRelevanceScore: 0.47,
  count: 6,
};

const DEFAULT_SCORING: Required<MemoryScoringConfig> = {
  transientHalfLifeDays: 30,
  decayFloor: 0.5,
  confirmBoostPerConfirm: 0.03,
  confirmBoostCap: 1.3,
};

/** Order core scopes are rendered in; any other scope follows alphabetically. */
const SCOPE_ORDER = [
  'identity',
  'preference',
  'opinion',
  'relationship',
  'behavior',
  'instruction',
  'topic',
  'rule',
  'event',
  'context',
];

const DAY_MS = 86_400_000;

export interface ReplyMemory {
  groupMemoryText: string;
  userMemoryText: string;
}

export interface MemorySearchResult {
  text: string;
  count: number;
}

export interface ManualSlot {
  groupId: string;
  userId: string;
}

/**
 * Relevance of a searched fact: similarity, weighted by how recently a transient fact was last
 * confirmed and by how often it has been confirmed. Stable facts do not decay.
 */
export function scoreFact(
  similarity: number,
  fact: Pick<MemoryFact, 'durability' | 'lastConfirmedAt' | 'confirmCount'>,
  scoring: Required<MemoryScoringConfig>,
  now: number,
): number {
  const ageDays = Math.max(0, (now - fact.lastConfirmedAt) / DAY_MS);
  const recency =
    fact.durability === 'transient' ? Math.max(scoring.decayFloor, 2 ** (-ageDays / scoring.transientHalfLifeDays)) : 1;
  const confirmation = Math.min(
    scoring.confirmBoostCap,
    1 + Math.max(0, fact.confirmCount - 1) * scoring.confirmBoostPerConfirm,
  );
  return similarity * recency * confirmation;
}

/** One slot as the LLM reads it: manual facts first (they win conflicts), then automatic ones, by scope. */
export function renderSlot(manual: ManualFact[], auto: Array<Pick<MemoryFact, 'scope' | 'content'>>): string {
  const autoText = renderByScope(auto);
  if (manual.length === 0) {
    return autoText;
  }
  const parts = [`【人工维护，与其他条目冲突时以此为准】\n${renderByScope(manual)}`];
  if (autoText) {
    parts.push(`【自动整理】\n${autoText}`);
  }
  return parts.join('\n\n');
}

function renderByScope(facts: Array<{ scope: string; content: string }>): string {
  const byScope = new Map<string, string[]>();
  for (const fact of facts) {
    const list = byScope.get(fact.scope);
    if (list) {
      list.push(fact.content);
    } else {
      byScope.set(fact.scope, [fact.content]);
    }
  }
  return [...byScope.entries()]
    .sort(([a], [b]) => compareScopes(a, b))
    .map(([scope, contents]) => `[${scope}]\n${contents.map((c) => `- ${c}`).join('\n')}`)
    .join('\n\n');
}

function compareScopes(a: string, b: string): number {
  const rank = (scope: string) => {
    const index = SCOPE_ORDER.indexOf(coreScopeOf(scope));
    return index === -1 ? SCOPE_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

@singleton()
export class MemoryService {
  private readonly basePath: string;
  private readonly filter: Required<MemoryFilterConfig>;
  private readonly scoring: Required<MemoryScoringConfig>;

  constructor(
    @inject(DITokens.CONFIG) config: Config,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(MemoryIndex) private readonly index: MemoryIndex,
  ) {
    const memoryConfig = config.getMemoryConfig();
    this.basePath = resolve(process.cwd(), memoryConfig.dir ?? DEFAULT_MEMORY_DIR);
    this.filter = { ...DEFAULT_FILTER, ...memoryConfig.filter };
    this.scoring = { ...DEFAULT_SCORING, ...memoryConfig.scoring };
  }

  isSearchEnabled(): boolean {
    return this.index.isEnabled();
  }

  getScoring(): Required<MemoryScoringConfig> {
    return this.scoring;
  }

  // ── Manual layer ──

  private manualPath(groupId: string, userId: string): string {
    const dirName = userId === GROUP_MEMORY_USER_ID ? GROUP_MEMORY_DIRNAME : sanitizePathSegment(userId);
    return join(this.basePath, sanitizePathSegment(groupId), dirName, MANUAL_FILENAME);
  }

  getManualText(groupId: string, userId: string): string {
    try {
      return readFileSync(this.manualPath(groupId, userId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[MemoryService] manual memory read failed:', err);
      }
      return '';
    }
  }

  getManualFacts(groupId: string, userId: string): ManualFact[] {
    return parseManualFacts(this.getManualText(groupId, userId));
  }

  async saveManualMemory(groupId: string, userId: string, content: string): Promise<void> {
    const path = this.manualPath(groupId, userId);
    await mkdir(dirname(path), { recursive: true });
    const trimmed = content.trim();
    await writeFile(path, trimmed ? `${trimmed}\n` : '', 'utf-8');
  }

  /** Every slot whose manual.txt has content. */
  listManualSlots(): ManualSlot[] {
    if (!existsSync(this.basePath)) {
      return [];
    }
    const slots: ManualSlot[] = [];
    for (const groupEntry of readdirSync(this.basePath, { withFileTypes: true })) {
      if (!groupEntry.isDirectory()) {
        continue;
      }
      const groupId = groupEntry.name;
      for (const slotEntry of readdirSync(join(this.basePath, groupId), { withFileTypes: true })) {
        if (!slotEntry.isDirectory()) {
          continue;
        }
        const userId = slotEntry.name === GROUP_MEMORY_DIRNAME ? GROUP_MEMORY_USER_ID : slotEntry.name;
        if (this.getManualText(groupId, userId).trim()) {
          slots.push({ groupId, userId });
        }
      }
    }
    return slots;
  }

  // ── Reads ──

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
      groupMemoryText: renderSlot(this.getManualFacts(groupId, GROUP_MEMORY_USER_ID), pick(groupAuto)),
      userMemoryText: userId ? renderSlot(this.getManualFacts(groupId, userId), pick(userAuto)) : '',
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
      logger.warn('[MemoryService] hit count write failed:', err);
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
      content: renderSlot(this.getManualFacts(groupId, slotUserId), auto),
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
    for (const slot of this.listManualSlots()) {
      if (slot.groupId !== groupId || !owns(slot.userId)) {
        continue;
      }
      for (const fact of this.getManualFacts(groupId, slot.userId)) {
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

  /** Bring a group's vector index back to its active facts. */
  async reconcileIndex(groupId: string): Promise<{ upserted: number; removed: number }> {
    return this.index.reconcile(groupId, await this.store.listGroup(groupId, 'active'));
  }
}

/** Allow only alphanumeric and underscore; replace other chars with _. */
function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_]/g, '_');
}
