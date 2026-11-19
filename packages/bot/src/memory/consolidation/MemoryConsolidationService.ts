// Folding new information into one memory slot, one operation per fact.
//
// The model sees the slot's active facts numbered, its manual facts read-only, and the new
// candidates, and answers with operations: add a fact, confirm an existing one, update
// (replace one or more facts with a corrected or merged one) or delete. Nothing is ever
// rewritten wholesale, so a fact keeps its id and its history until an operation names it.
//
// The request is written when the job is submitted and the answer applied when it comes back,
// possibly hours later: operations naming a fact that has changed in between are rejected.

import { logger } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { DITokens } from '@/core/DITokens';
import type { MemoryFact } from '@/database/models/types';
import type { MemoryRequest } from '../llm/memoryLLM';
import { listManualFacts, numberFacts, scopeGuide } from '../llm/promptParts';
import { operationFactId } from '../model/jobIds';
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
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(ManualMemoryStore) private readonly manualStore: ManualMemoryStore,
  ) {}

  /** The request for folding `candidates` into the slot as it is now; null when there is nothing to fold. */
  async prepareSlot(groupId: string, userId: string, candidates: string[]): Promise<MemoryRequest | null> {
    const newFacts = candidates.map((c) => c.trim()).filter(Boolean);
    if (newFacts.length === 0) {
      return null;
    }
    const existing = await this.store.listSlot(groupId, userId, 'active');
    const prompt = this.promptManager.render('memory.consolidate', {
      slotLabel: slotLabel(userId),
      scopeGuide: scopeGuide(this.promptManager, userId),
      manualFacts: listManualFacts(this.manualStore.getFacts(groupId, userId)),
      existingFacts: numberFacts(existing),
      newFacts: newFacts.map((fact) => `- ${fact}`).join('\n'),
    });
    return { prompt, factIds: existing.map((fact) => fact.id), dueIds: [] };
  }

  /** Apply a consolidation answer; `jobId` keys the facts it adds, so applying it again adds nothing. */
  async applySlotAnswer(
    groupId: string,
    userId: string,
    request: MemoryRequest,
    answer: Record<string, unknown>,
    jobId: string,
  ): Promise<ConsolidationSummary> {
    const summary: ConsolidationSummary = { added: 0, confirmed: 0, updated: 0, deleted: 0, rejected: 0 };
    const numbered = await this.store.activeInSlot(groupId, userId, request.factIds);
    const { operations, rejected } = parseSlotOperations(answer, numbered, userId);
    summary.rejected = rejected;
    await this.apply(groupId, userId, numbered, operations, summary, jobId);
    logger.info(
      `[MemoryConsolidation] group=${groupId} slot=${userId} ` +
        `add=${summary.added} confirm=${summary.confirmed} update=${summary.updated} ` +
        `delete=${summary.deleted} rejected=${summary.rejected}`,
    );
    return summary;
  }

  private async apply(
    groupId: string,
    userId: string,
    numbered: Array<MemoryFact | null>,
    operations: SlotOperation[],
    summary: ConsolidationSummary,
    jobId: string,
  ): Promise<void> {
    const now = Date.now();
    const byId = new Map(numbered.filter((f): f is MemoryFact => f !== null).map((fact) => [fact.id, fact]));
    for (const [index, operation] of operations.entries()) {
      switch (operation.op) {
        case 'add':
          await this.store.add([
            {
              id: operationFactId(jobId, index),
              groupId,
              userId,
              ...operation.fact,
              firstSeen: now,
              lastConfirmedAt: now,
              confirmCount: 1,
            },
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
              id: operationFactId(jobId, index),
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
