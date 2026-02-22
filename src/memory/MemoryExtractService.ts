// Memory Extract Service - extract from messages, merge with existing via analyze, then upsert

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import type { MemoryService } from './MemoryService';
import { GROUP_MEMORY_USER_ID } from './MemoryService';

/** Default LLM provider for extract and analyze (e.g. ollama). */
const DEFAULT_EXTRACT_PROVIDER = 'ollama';

/**
 * Extract output shape from prompts/memory/extract.txt:
 * group_facts: Array<{ scope, content }> (or legacy string[]),
 * user_facts: Array<{ user_id, facts: Array<{ scope, content }> }> (or legacy facts: string[]).
 * Normalized to string[] per slot (each string = "[scope] content" or plain content).
 */
export interface ExtractResult {
  groupFacts?: string[];
  userFacts?: Array<{ userId: string; facts: string[] }>;
}

export interface MemoryExtractServiceOptions {
  provider?: string;
}

export class MemoryExtractService {
  /** Serial queue: only one extract/analyze job runs at a time; others wait. */
  private extractQueue: Promise<void> = Promise.resolve();

  constructor(
    private promptManager: PromptManager,
    private llmService: LLMService,
    private memoryService: MemoryService,
  ) {}

  /**
   * Merge new facts with existing memory using memory.analyze template.
   * Returns the merged memory text (one line per item); empty string if analyze returns nothing.
   */
  async mergeWithExisting(
    existingMemory: string,
    newFacts: string,
    options: MemoryExtractServiceOptions = {},
  ): Promise<string> {
    if (!newFacts.trim()) {
      return existingMemory.trim();
    }
    const provider = options.provider ?? DEFAULT_EXTRACT_PROVIDER;
    const prompt = this.promptManager.render(
      'memory.analyze',
      {
        existingMemory: existingMemory || '(无)',
        newFacts: newFacts.trim(),
        adminUserId: this.promptManager.adminUserId,
      },
      { injectBase: true },
    );

    // logger.info('[MemoryExtractService] Analyze full prompt:\n' + prompt);

    try {
      const res = await this.llmService.generate(
        prompt,
        {
          temperature: 0.4,
          maxTokens: 20000,
        },
        provider,
      );
      const merged = (res.text ?? '').trim();
      return merged;
    } catch (err) {
      logger.error('[MemoryExtractService] LLM analyze failed:', err);
      return existingMemory.trim();
    }
  }

  /**
   * Extract from messages and upsert only the given user's memory (no group memory).
   * Queued: runs after previous extract job completes (single-threaded).
   */
  async extractAndUpsertUserOnly(
    groupId: string,
    userId: string,
    recentMessagesText: string,
    options: MemoryExtractServiceOptions = {},
  ): Promise<void> {
    const prev = this.extractQueue;
    this.extractQueue = prev.then(() => this.runExtractAndUpsertUserOnly(groupId, userId, recentMessagesText, options));
    return this.extractQueue;
  }

  /** Internal: one extract+merge+upsert job for a single user (run under queue). */
  private async runExtractAndUpsertUserOnly(
    groupId: string,
    userId: string,
    recentMessagesText: string,
    options: MemoryExtractServiceOptions,
  ): Promise<void> {
    const provider = options.provider ?? DEFAULT_EXTRACT_PROVIDER;
    const inputText = recentMessagesText || '(no messages)';
    const targetUserSection = this.promptManager.render('memory.extract_single_user', {
      targetUserId: userId,
    });
    const prompt = this.promptManager.render(
      'memory.extract',
      {
        groupId,
        recentMessagesText: inputText,
        targetUserSection,
      },
      { injectBase: true },
    );

    // logger.info('[MemoryExtractService] Extract full prompt:\n' + prompt);

    let response: string;
    try {
      const res = await this.llmService.generate(
        prompt,
        {
          temperature: 0.4,
          maxTokens: 20000, // use long context for extract.
        },
        provider,
      );
      response = (res.text ?? '').trim();
      logger.debug('[MemoryExtractService] runExtractAndUpsertUserOnly result:', { response });
    } catch (err) {
      logger.error('[MemoryExtractService] LLM extract failed (userOnly):', err);
      return;
    }

    const parsed = this.parseExtractOutput(response);
    if (!parsed) {
      return;
    }

    const userFacts = (parsed.userFacts ?? []).filter((u) => u.userId === userId);
    if (userFacts.length === 0) {
      logger.debug(`[MemoryExtractService] extractUserOnly group=${groupId} user=${userId}: no facts extracted, skip`);
      return;
    }

    try {
      const newFactsText = userFacts
        .flatMap((u) => u.facts)
        .filter(Boolean)
        .join('\n');
      if (!newFactsText.trim()) {
        return;
      }
      const existing = this.memoryService.getUserMemoryText(groupId, userId);
      const merged = await this.mergeWithExisting(existing, newFactsText, options);
      if (merged) {
        await this.memoryService.upsertMemory(groupId, userId, false, merged);
      }
      logger.info(`[MemoryExtractService] memory updated | group=${groupId} user=${userId} |\n${merged}`);
    } catch (err) {
      logger.error('[MemoryExtractService] merge/upsert failed (userOnly):', err);
    }
  }

  /**
   * Extract from recent messages (memory.extract), then for each slot merge with existing (memory.analyze) and upsert.
   * Queued: runs after previous extract job completes (single-threaded).
   */
  async extractAndUpsert(
    groupId: string,
    recentMessagesText: string,
    options: MemoryExtractServiceOptions = {},
  ): Promise<void> {
    const prev = this.extractQueue;
    this.extractQueue = prev.then(() => this.runExtractAndUpsert(groupId, recentMessagesText, options));
    return this.extractQueue;
  }

  /** Internal: one extract+merge+upsert job for a group (run under queue). */
  private async runExtractAndUpsert(
    groupId: string,
    recentMessagesText: string,
    options: MemoryExtractServiceOptions,
  ): Promise<void> {
    const provider = options.provider ?? DEFAULT_EXTRACT_PROVIDER;
    const prompt = this.promptManager.render('memory.extract', {
      groupId,
      recentMessagesText: recentMessagesText || '(no messages)',
      targetUserSection: '',
    });

    let response: string;
    try {
      const res = await this.llmService.generate(
        prompt,
        {
          temperature: 0.4,
          maxTokens: 20000,
        },
        provider,
      );
      response = (res.text ?? '').trim();
    } catch (err) {
      logger.error('[MemoryExtractService] LLM extract failed:', err);
      return;
    }

    const parsed = this.parseExtractOutput(response);
    if (!parsed) {
      return;
    }

    const userIds = (parsed.userFacts ?? []).map((u) => u.userId).filter(Boolean);
    logger.info(
      `[MemoryExtractService] extract done | group=${groupId} | group_facts=${parsed.groupFacts?.length ?? 0} user_facts_users=[${userIds.join(',')}]`,
    );

    try {
      // for group global memory
      if (parsed.groupFacts && parsed.groupFacts.length > 0) {
        const existing = this.memoryService.getGroupMemoryText(groupId);
        const newFactsText = parsed.groupFacts.join('\n');
        const merged = await this.mergeWithExisting(existing, newFactsText, options);
        if (merged) {
          await this.memoryService.upsertMemory(groupId, GROUP_MEMORY_USER_ID, true, merged);
        }
        logger.info(`[MemoryExtractService] memory updated | group=${groupId} target=GROUP_GLOBAL |\n${merged}`);
      }

      // for user memory
      for (const u of parsed.userFacts ?? []) {
        if (!u.userId || !u.facts?.length) {
          continue;
        }
        const existing = this.memoryService.getUserMemoryText(groupId, u.userId);
        const newFactsText = u.facts.join('\n');
        const merged = await this.mergeWithExisting(existing, newFactsText, options);
        if (merged) {
          await this.memoryService.upsertMemory(groupId, u.userId, false, merged);
        }
        logger.info(`[MemoryExtractService] memory updated | group=${groupId} user=${u.userId} |\n${merged}`);
      }
    } catch (err) {
      logger.error('[MemoryExtractService] merge/upsert failed:', err);
    }
  }

  /**
   * Normalize a fact from extract: either string (legacy) or { scope, content }.
   * Returns string for storage (e.g. "[scope] content" when scope present).
   */
  private normalizeFact(f: unknown): string | null {
    if (typeof f === 'string' && f.trim()) {
      return f.trim();
    }
    if (f && typeof f === 'object' && 'content' in f) {
      const o = f as Record<string, unknown>;
      const content = typeof o.content === 'string' ? o.content.trim() : '';
      if (!content) {
        return null;
      }
      const scope = typeof o.scope === 'string' ? o.scope.trim() : '';
      return scope ? `[${scope}] ${content}` : content;
    }
    return null;
  }

  /**
   * Parse extract output: group_facts and user_facts[].facts can be string[] or Array<{ scope, content }>.
   */
  private parseExtractOutput(text: string): ExtractResult | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : text;
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;
      const result: ExtractResult = {};
      if (Array.isArray(obj.group_facts)) {
        result.groupFacts = obj.group_facts.map((f) => this.normalizeFact(f)).filter((s): s is string => s != null);
      }
      if (Array.isArray(obj.user_facts)) {
        result.userFacts = [];
        for (const item of obj.user_facts) {
          const row = item as Record<string, unknown>;
          if (
            !row ||
            (row.user_id !== undefined && typeof row.user_id !== 'string' && typeof row.user_id !== 'number')
          ) {
            continue;
          }
          const userId = row.user_id != null ? String(row.user_id).trim() : '';
          if (!userId) {
            continue;
          }
          if (!Array.isArray(row.facts)) {
            continue;
          }
          const facts = (row.facts as unknown[])
            .map((f) => this.normalizeFact(f))
            .filter((s): s is string => s != null);
          result.userFacts.push({ userId, facts });
        }
      }
      return result;
    } catch {
      logger.debug('[MemoryExtractService] Could not parse extract output as JSON, skipping');
      return null;
    }
  }
}
