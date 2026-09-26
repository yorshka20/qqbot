// Periodic review of facts nobody has mentioned in a while.
//
// A fact is due when neither a confirmation nor an earlier review has touched it for its
// durability's threshold (config `memory.review`). The model sees the whole slot with the due
// facts marked and decides, per due fact: keep it (it is long-lived), retire it (it only held
// at the time), or merge it with a fact saying the same thing. Retiring changes the status;
// the row stays. A fact the model leaves out counts as kept.

import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import type { MemoryReviewConfig } from '@/core/config/types/memory';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { listManualFacts, type NewFactDraft, parseDraft } from './MemoryConsolidationService';
import { MemoryFactStore } from './MemoryFactStore';
import { MemoryService } from './MemoryService';
import { generateMemoryJson, type MemoryLLMOptions } from './memoryLLM';
import { scopeGuide, slotLabel } from './memoryScopes';

const DAY_MS = 86_400_000;

const DEFAULT_REVIEW: Required<MemoryReviewConfig> = {
  transientAfterDays: 30,
  stableAfterDays: 180,
};

export type ReviewDecision =
  | { op: 'keep'; id: string; durability?: MemoryFact['durability'] }
  | { op: 'retire'; id: string; reason: string }
  | { op: 'merge'; ids: string[]; fact: NewFactDraft };

export interface ReviewSummary {
  due: number;
  kept: number;
  retired: number;
  merged: number;
}

export function isDue(
  fact: Pick<MemoryFact, 'durability' | 'lastConfirmedAt' | 'reviewedAt'>,
  review: Required<MemoryReviewConfig>,
  now: number,
): boolean {
  const lastTouched = Math.max(fact.lastConfirmedAt, fact.reviewedAt ?? 0);
  const days = fact.durability === 'transient' ? review.transientAfterDays : review.stableAfterDays;
  return now - lastTouched >= days * DAY_MS;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function numberFactsForReview(facts: MemoryFact[], due: Set<string>): string {
  return facts
    .map(
      (fact, i) =>
        `${due.has(fact.id) ? '待复审 ' : ''}#${i + 1} [${fact.scope}] (${fact.durability}) ${fact.content}` +
        ` ｜ ${formatDate(fact.firstSeen)} ｜ ${formatDate(fact.lastConfirmedAt)} ｜ ${fact.confirmCount} ｜ ${fact.hitCount}`,
    )
    .join('\n');
}

/**
 * Validate review decisions. keep/retire must name a due fact; merge may name any listed fact
 * but must include at least one due fact. Each fact is named by at most one decision.
 */
export function parseReviewDecisions(
  answer: Record<string, unknown>,
  numbered: MemoryFact[],
  due: Set<string>,
  userId: string,
): { decisions: ReviewDecision[]; rejected: number } {
  const raw = Array.isArray(answer.decisions) ? answer.decisions : [];
  const claimed = new Set<string>();
  const factAt = (value: unknown): MemoryFact | null => {
    const index = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    const fact = Number.isInteger(index) ? numbered[index - 1] : undefined;
    return fact && !claimed.has(fact.id) ? fact : null;
  };
  const decisions: ReviewDecision[] = [];
  let rejected = 0;
  for (const item of raw) {
    const d = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (d.op === 'keep' || d.op === 'retire') {
      const target = factAt(d.id);
      if (target && due.has(target.id)) {
        claimed.add(target.id);
        if (d.op === 'keep') {
          const durability = d.durability === 'stable' || d.durability === 'transient' ? d.durability : undefined;
          decisions.push({ op: 'keep', id: target.id, durability });
        } else {
          decisions.push({ op: 'retire', id: target.id, reason: typeof d.reason === 'string' ? d.reason : '临时信息' });
        }
        continue;
      }
    } else if (d.op === 'merge') {
      const fact = parseDraft(d, userId);
      const targets = (Array.isArray(d.ids) ? d.ids : []).map(factAt);
      const valid = targets.length >= 2 && targets.every((t): t is MemoryFact => t !== null);
      if (fact && valid && targets.some((t) => t !== null && due.has(t.id))) {
        const ids = [...new Set((targets as MemoryFact[]).map((t) => t.id))];
        for (const id of ids) {
          claimed.add(id);
        }
        decisions.push({ op: 'merge', ids, fact });
        continue;
      }
    }
    rejected++;
  }
  return { decisions, rejected };
}

@singleton()
export class MemoryReviewService {
  private readonly review: Required<MemoryReviewConfig>;

  constructor(
    @inject(DITokens.CONFIG) config: Config,
    @inject(DITokens.PROMPT_MANAGER) private readonly promptManager: PromptManager,
    @inject(LLMService) private readonly llmService: LLMService,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(MemoryService) private readonly memoryService: MemoryService,
  ) {
    this.review = { ...DEFAULT_REVIEW, ...config.getMemoryConfig().review };
  }

  /** Review every slot of a group that has a due fact. */
  async reviewGroup(groupId: string, options: MemoryLLMOptions, now = Date.now()): Promise<ReviewSummary> {
    const total: ReviewSummary = { due: 0, kept: 0, retired: 0, merged: 0 };
    const active = await this.store.listGroup(groupId, 'active');
    const slots = [...new Set(active.filter((fact) => isDue(fact, this.review, now)).map((fact) => fact.userId))];
    for (const userId of slots) {
      const summary = await this.reviewSlot(groupId, userId, options, now);
      total.due += summary.due;
      total.kept += summary.kept;
      total.retired += summary.retired;
      total.merged += summary.merged;
    }
    return total;
  }

  async reviewSlot(
    groupId: string,
    userId: string,
    options: MemoryLLMOptions,
    now = Date.now(),
  ): Promise<ReviewSummary> {
    const facts = await this.store.listSlot(groupId, userId, 'active');
    const due = new Set(facts.filter((fact) => isDue(fact, this.review, now)).map((fact) => fact.id));
    const summary: ReviewSummary = { due: due.size, kept: 0, retired: 0, merged: 0 };
    if (due.size === 0) {
      return summary;
    }
    const prompt = this.promptManager.render('memory.review', {
      slotLabel: slotLabel(userId),
      scopeGuide: scopeGuide(this.promptManager, userId),
      manualFacts: listManualFacts(this.memoryService.getManualFacts(groupId, userId)),
      facts: numberFactsForReview(facts, due),
      today: formatDate(now),
    });
    const answer = await generateMemoryJson(this.llmService, prompt, options, 'MemoryReview');
    if (!answer) {
      return summary;
    }
    const { decisions, rejected } = parseReviewDecisions(answer, facts, due, userId);
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const removed = new Set<string>();
    for (const decision of decisions) {
      if (decision.op === 'keep') {
        if (decision.durability && decision.durability !== byId.get(decision.id)?.durability) {
          await this.store.patch(decision.id, { durability: decision.durability });
        }
      } else if (decision.op === 'retire') {
        await this.store.retire(groupId, [decision.id], decision.reason);
        removed.add(decision.id);
        summary.retired++;
      } else {
        const merged = decision.ids.map((id) => byId.get(id)).filter((f): f is MemoryFact => f !== undefined);
        const [created] = await this.store.add([
          {
            groupId,
            userId,
            ...decision.fact,
            firstSeen: Math.min(...merged.map((f) => f.firstSeen)),
            lastConfirmedAt: Math.max(...merged.map((f) => f.lastConfirmedAt)),
            confirmCount: Math.max(...merged.map((f) => f.confirmCount)),
          },
        ]);
        await this.store.markReviewed([created.id], now);
        await this.store.supersede(groupId, decision.ids, '复审合并', created.id);
        for (const id of decision.ids) {
          removed.add(id);
        }
        summary.merged++;
      }
    }
    const kept = [...due].filter((id) => !removed.has(id));
    await this.store.markReviewed(kept, now);
    summary.kept = kept.length;
    logger.info(
      `[MemoryReview] group=${groupId} slot=${userId} due=${summary.due} kept=${summary.kept} ` +
        `retired=${summary.retired} merged=${summary.merged} rejected=${rejected}`,
    );
    return summary;
  }
}
