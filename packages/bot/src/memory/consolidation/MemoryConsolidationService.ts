// Folding new information into one memory slot, one operation per fact.
//
// The model sees the slot's active facts numbered, its manual facts read-only, and the new
// candidates, and answers with operations: add a fact, confirm an existing one, update
// (replace one or more facts with a corrected or merged one) or delete. Nothing is ever
// rewritten wholesale, so a fact keeps its id and its history until an operation names it.

import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { LLMService } from '@/ai/services/LLMService';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { generateMemoryJson, type MemoryLLMOptions } from '../llm/memoryLLM';
import { listManualFacts, numberFacts, scopeGuide } from '../llm/promptParts';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { slotLabel } from '../model/scopes';
import { ManualMemoryStore } from '../storage/ManualMemoryStore';
import { MemoryFactStore } from '../storage/MemoryFactStore';
import { parseSlotOperations, type SlotOperation } from './slotOperations';

export interface ConsolidationSummary {
  added: number;
  confirmed: number;
  updated: number;
  deleted: number;
  rejected: number;
}

@singleton()
export class MemoryConsolidationService {
  constructor(
    @inject(DITokens.PROMPT_MANAGER) private readonly promptManager: PromptManager,
    @inject(LLMService) private readonly llmService: LLMService,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(ManualMemoryStore) private readonly manualStore: ManualMemoryStore,
  ) {}

  /** Consolidate candidates into the group's slot and each member's slot, one slot at a time. */
  async consolidate(
    groupId: string,
    groupFacts: string[],
    userFacts: Map<string, string[]>,
    options: MemoryLLMOptions,
  ): Promise<void> {
    if (groupFacts.length > 0) {
      await this.consolidateSlot(groupId, GROUP_MEMORY_USER_ID, groupFacts, options);
    }
    for (const [userId, facts] of userFacts) {
      if (userId && facts.length > 0) {
        await this.consolidateSlot(groupId, userId, facts, options);
      }
    }
  }

  async consolidateSlot(
    groupId: string,
    userId: string,
    candidates: string[],
    options: MemoryLLMOptions,
  ): Promise<ConsolidationSummary> {
    const summary: ConsolidationSummary = { added: 0, confirmed: 0, updated: 0, deleted: 0, rejected: 0 };
    const newFacts = candidates.map((c) => c.trim()).filter(Boolean);
    if (newFacts.length === 0) {
      return summary;
    }
    const existing = await this.store.listSlot(groupId, userId, 'active');
    const prompt = this.promptManager.render('memory.consolidate', {
      slotLabel: slotLabel(userId),
      scopeGuide: scopeGuide(this.promptManager, userId),
      manualFacts: listManualFacts(this.manualStore.getFacts(groupId, userId)),
      existingFacts: numberFacts(existing),
      newFacts: newFacts.map((fact) => `- ${fact}`).join('\n'),
    });
    const answer = await generateMemoryJson(this.llmService, prompt, options, 'MemoryConsolidation');
    if (!answer) {
      return summary;
    }
    const { operations, rejected } = parseSlotOperations(answer, existing, userId);
    summary.rejected = rejected;
    await this.apply(groupId, userId, existing, operations, summary);
    logger.info(
      `[MemoryConsolidation] group=${groupId} slot=${userId} candidates=${newFacts.length} ` +
        `add=${summary.added} confirm=${summary.confirmed} update=${summary.updated} ` +
        `delete=${summary.deleted} rejected=${summary.rejected}`,
    );
    return summary;
  }

  private async apply(
    groupId: string,
    userId: string,
    existing: MemoryFact[],
    operations: SlotOperation[],
    summary: ConsolidationSummary,
  ): Promise<void> {
    const now = Date.now();
    const byId = new Map(existing.map((fact) => [fact.id, fact]));
    for (const operation of operations) {
      switch (operation.op) {
        case 'add':
          await this.store.add([
            { groupId, userId, ...operation.fact, firstSeen: now, lastConfirmedAt: now, confirmCount: 1 },
          ]);
          summary.added++;
          break;
        case 'confirm':
          await this.store.confirm([operation.id], now);
          summary.confirmed++;
          break;
        case 'delete':
          await this.store.supersede(groupId, [operation.id], operation.reason);
          summary.deleted++;
          break;
        case 'update': {
          const replaced = operation.ids.map((id) => byId.get(id)).filter((f): f is MemoryFact => f !== undefined);
          const [created] = await this.store.add([
            {
              groupId,
              userId,
              ...operation.fact,
              firstSeen: Math.min(...replaced.map((f) => f.firstSeen)),
              lastConfirmedAt: now,
              confirmCount: Math.max(...replaced.map((f) => f.confirmCount)) + 1,
            },
          ]);
          await this.store.supersede(groupId, operation.ids, '被更新或合并', created.id);
          summary.updated++;
          break;
        }
      }
    }
  }
}
