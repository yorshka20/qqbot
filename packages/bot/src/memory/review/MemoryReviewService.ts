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
import { generateMemoryJson, type MemoryLLMOptions } from '../llm/memoryLLM';
import { listManualFacts, scopeGuide } from '../llm/promptParts';
import { slotLabel } from '../model/scopes';
import { ManualMemoryStore } from '../storage/ManualMemoryStore';
import { MemoryFactStore } from '../storage/MemoryFactStore';
import { formatDate, isDue, numberFactsForReview, parseReviewDecisions } from './reviewDecisions';

const DEFAULT_REVIEW: Required<MemoryReviewConfig> = {
  transientAfterDays: 30,
  stableAfterDays: 180,
};

export interface ReviewSummary {
  due: number;
  kept: number;
  retired: number;
  merged: number;
}

@singleton()
export class MemoryReviewService {
  private readonly review: Required<MemoryReviewConfig>;

  constructor(
    @inject(DITokens.CONFIG) config: Config,
    @inject(DITokens.PROMPT_MANAGER) private readonly promptManager: PromptManager,
    @inject(LLMService) private readonly llmService: LLMService,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(ManualMemoryStore) private readonly manualStore: ManualMemoryStore,
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
      manualFacts: listManualFacts(this.manualStore.getFacts(groupId, userId)),
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
