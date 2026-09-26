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
import { MemoryFactStore } from './MemoryFactStore';
import { MemoryService } from './MemoryService';
import type { ManualFact } from './manualMemory';
import { GROUP_MEMORY_USER_ID } from './memoryConstants';
import { generateMemoryJson, type MemoryLLMOptions } from './memoryLLM';
import { isAllowedScope, scopeGuide, slotLabel } from './memoryScopes';

export interface NewFactDraft {
  scope: string;
  content: string;
  durability: MemoryFact['durability'];
}

export type SlotOperation =
  | { op: 'add'; fact: NewFactDraft }
  | { op: 'confirm'; id: string }
  | { op: 'update'; ids: string[]; fact: NewFactDraft }
  | { op: 'delete'; id: string; reason: string };

export interface ConsolidationSummary {
  added: number;
  confirmed: number;
  updated: number;
  deleted: number;
  rejected: number;
}

const MAX_FACT_LENGTH = 120;

/** `#n [scope] (durability) content`, numbered from 1 in the order given. */
export function numberFacts(facts: Array<Pick<MemoryFact, 'scope' | 'durability' | 'content'>>): string {
  if (facts.length === 0) {
    return '（无）';
  }
  return facts.map((fact, i) => `#${i + 1} [${fact.scope}] (${fact.durability}) ${fact.content}`).join('\n');
}

export function listManualFacts(facts: ManualFact[]): string {
  return facts.length === 0 ? '（无）' : facts.map((fact) => `- [${fact.scope}] ${fact.content}`).join('\n');
}

/**
 * A draft fact from model output, or null when it cannot be stored as is. A missing or unknown
 * durability reads as transient: such a fact decays and comes up for review instead of lingering.
 */
export function parseDraft(raw: Record<string, unknown>, userId: string): NewFactDraft | null {
  const scope = typeof raw.scope === 'string' ? raw.scope.trim().toLowerCase() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content || content.length > MAX_FACT_LENGTH || !isAllowedScope(userId, scope)) {
    return null;
  }
  return { scope, content, durability: raw.durability === 'stable' ? 'stable' : 'transient' };
}

/**
 * Validate the model's operations against the numbered facts. Each existing fact is named by
 * at most one operation; later operations naming it again are rejected.
 */
export function parseSlotOperations(
  answer: Record<string, unknown>,
  numbered: MemoryFact[],
  userId: string,
): { operations: SlotOperation[]; rejected: number } {
  const raw = Array.isArray(answer.operations) ? answer.operations : [];
  const claimed = new Set<string>();
  const factAt = (value: unknown): MemoryFact | null => {
    const index = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    const fact = Number.isInteger(index) ? numbered[index - 1] : undefined;
    return fact && !claimed.has(fact.id) ? fact : null;
  };
  const operations: SlotOperation[] = [];
  let rejected = 0;
  for (const item of raw) {
    const op = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (op.op === 'add') {
      const fact = parseDraft(op, userId);
      if (fact) {
        operations.push({ op: 'add', fact });
        continue;
      }
    } else if (op.op === 'confirm' || op.op === 'delete') {
      const target = factAt(op.id);
      if (target) {
        claimed.add(target.id);
        operations.push(
          op.op === 'confirm'
            ? { op: 'confirm', id: target.id }
            : { op: 'delete', id: target.id, reason: typeof op.reason === 'string' ? op.reason : '被新信息推翻' },
        );
        continue;
      }
    } else if (op.op === 'update') {
      const fact = parseDraft(op, userId);
      const targets = (Array.isArray(op.ids) ? op.ids : [op.id]).map(factAt);
      if (fact && targets.length > 0 && targets.every((t): t is MemoryFact => t !== null)) {
        const ids = [...new Set(targets.map((t) => t.id))];
        for (const id of ids) {
          claimed.add(id);
        }
        operations.push({ op: 'update', ids, fact });
        continue;
      }
    }
    rejected++;
  }
  return { operations, rejected };
}

@singleton()
export class MemoryConsolidationService {
  constructor(
    @inject(DITokens.PROMPT_MANAGER) private readonly promptManager: PromptManager,
    @inject(LLMService) private readonly llmService: LLMService,
    @inject(MemoryFactStore) private readonly store: MemoryFactStore,
    @inject(MemoryService) private readonly memoryService: MemoryService,
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
      manualFacts: listManualFacts(this.memoryService.getManualFacts(groupId, userId)),
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
