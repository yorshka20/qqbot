// Memory Extract Service - extract from messages, merge with existing via analyze, then upsert
// Supports hierarchical scopes: [core_scope:subtag] format

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { GROUP_CORE_SCOPES, type ParsedScope, USER_CORE_SCOPES } from '@/core/config/types/memory';
import { logger } from '@/utils/logger';
import type { MemoryService } from './MemoryService';
import { GROUP_MEMORY_USER_ID } from './MemoryService';

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
  /** LLM provider name (required — must be resolved from config by caller). */
  provider: string;
}

export class MemoryExtractService {
  /** Serial queue: only one extract/analyze job runs at a time; others wait. */
  private extractQueue: Promise<void> = Promise.resolve();

  constructor(
    private promptManager: PromptManager,
    private llmService: LLMService,
    private memoryService: MemoryService,
  ) {}

  // ============================================================================
  // Scope template variable helpers
  // ============================================================================

  /** Get user core scopes as comma-separated string */
  private getUserCoreScopesStr(): string {
    return USER_CORE_SCOPES.join(' / ');
  }

  /** Get group core scopes as comma-separated string */
  private getGroupCoreScopesStr(): string {
    return GROUP_CORE_SCOPES.join(' / ');
  }

  /** Get user scope descriptions as formatted string (loaded from template) */
  private getUserScopeDescriptionsStr(): string {
    return this.promptManager.render('memory.scopes_user');
  }

  /** Get group scope descriptions as formatted string (loaded from template) */
  private getGroupScopeDescriptionsStr(): string {
    return this.promptManager.render('memory.scopes_group');
  }

  /** Format existing scopes for AI reference */
  private formatExistingScopes(scopes: ParsedScope[]): string {
    if (scopes.length === 0) {
      return '(无已有 scope)';
    }
    return scopes.map((s) => s.full).join(', ');
  }

  /** Get common scope variables for template rendering */
  private getScopeTemplateVars(): Record<string, string> {
    return {
      userCoreScopes: this.getUserCoreScopesStr(),
      groupCoreScopes: this.getGroupCoreScopesStr(),
      userScopeDescriptions: this.getUserScopeDescriptionsStr(),
      groupScopeDescriptions: this.getGroupScopeDescriptionsStr(),
    };
  }

  /** Get available scopes section for analyze template based on memory type */
  private getAvailableScopesSection(memoryType: 'user' | 'global'): string {
    if (memoryType === 'user') {
      return `**user 记忆可用**：${this.getUserCoreScopesStr()}
⚠️ user 记忆中不能包含 \`rule\`。若新信息涉及群规或 bot 行为规则，直接丢弃。`;
    }
    return `**global 记忆可用**：${this.getGroupCoreScopesStr()}
\`rule\` 只能存在于 global 记忆中，记录 bot 的群级行为设定、群公告等。`;
  }

  /**
   * Normalize merged memory so that each bullet line contains at most one fact.
   * Splits lines like " - A；B；C" into " - A\n - B\n - C" so output is one fact per line even if LLM merged multiple facts.
   */
  private normalizeOneFactPerLine(text: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
      const bulletMatch = line.match(/^(\s*-\s+)(.*)$/);
      if (!bulletMatch) {
        out.push(line);
        continue;
      }
      const prefix = bulletMatch[1];
      const content = bulletMatch[2];
      // Split by full-width or half-width semicolon (fact-level separator)
      const parts = content
        .split(/[；;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length <= 1) {
        out.push(line);
        continue;
      }
      for (const part of parts) {
        out.push(prefix + part);
      }
    }
    return out.join('\n');
  }

  /**
   * Merge new facts with existing memory using memory.analyze template.
   * Returns the merged memory text (one line per item); empty string if analyze returns nothing.
   * Post-processes LLM output to ensure one fact per bullet line (splits by ；;).
   */
  async mergeWithExisting(
    existingMemory: string,
    newFacts: string,
    memoryType: 'user' | 'global',
    options: MemoryExtractServiceOptions,
  ): Promise<string> {
    if (!newFacts.trim()) {
      return existingMemory.trim();
    }
    const provider = options.provider;
    const baseSystemPrompt = this.promptManager.renderBasePrompt();

    // Get existing scopes for AI reference (to encourage scope reuse)
    const existingScopes = this.memoryService.extractAllScopes(existingMemory);
    const existingScopesStr = this.formatExistingScopes(existingScopes);

    const prompt = this.promptManager.render('memory.analyze', {
      existingMemory: existingMemory || '(无)',
      newFacts: newFacts.trim(),
      adminUserId: this.promptManager.adminUserId,
      memoryType,
      existingScopes: existingScopesStr,
      availableScopesSection: this.getAvailableScopesSection(memoryType),
      ...this.getScopeTemplateVars(),
    });

    try {
      const res = await this.llmService.generate(
        prompt,
        {
          temperature: 0.4,
          maxTokens: 10000,
          systemPrompt: baseSystemPrompt,
        },
        provider,
      );
      let merged = (res.text ?? '').trim();
      merged = this.normalizeOneFactPerLine(merged);
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
    options: MemoryExtractServiceOptions,
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
    const provider = options.provider;
    const inputText = recentMessagesText || '(no messages)';
    const baseSystemPrompt = this.promptManager.renderBasePrompt();
    const targetUserSection = this.promptManager.render('memory.extract_single_user', {
      targetUserId: userId,
    });
    const prompt = this.promptManager.render('memory.extract', {
      groupId,
      recentMessagesText: inputText,
      targetUserSection,
      ...this.getScopeTemplateVars(),
    });

    // logger.info('[MemoryExtractService] Extract full prompt:\n' + prompt);

    let response: string;
    try {
      const res = await this.llmService.generate(
        prompt,
        {
          temperature: 0.4,
          maxTokens: 20000, // use long context for extract.
          systemPrompt: baseSystemPrompt,
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
      const existing = this.memoryService.getUserMemoryTextByLayer(groupId, userId, 'auto');
      const merged = await this.mergeWithExisting(existing, newFactsText, 'user', options);
      if (merged) {
        await this.memoryService.upsertMemory(groupId, userId, false, merged, 'auto', 'llm_extract');
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
    options: MemoryExtractServiceOptions,
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
    const provider = options.provider;
    const prompt = this.promptManager.render('memory.extract', {
      groupId,
      recentMessagesText: recentMessagesText || '(no messages)',
      targetUserSection: '',
      ...this.getScopeTemplateVars(),
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
      // for group global memory (read/write auto layer only)
      if (parsed.groupFacts && parsed.groupFacts.length > 0) {
        const existing = this.memoryService.getGroupMemoryTextByLayer(groupId, 'auto');
        const newFactsText = parsed.groupFacts.join('\n');
        const merged = await this.mergeWithExisting(existing, newFactsText, 'global', options);
        if (merged) {
          await this.memoryService.upsertMemory(groupId, GROUP_MEMORY_USER_ID, true, merged, 'auto', 'llm_extract');
        }
        logger.info(`[MemoryExtractService] memory updated | group=${groupId} target=GROUP_GLOBAL |\n${merged}`);
      }

      // for user memory (read/write auto layer only)
      for (const u of parsed.userFacts ?? []) {
        if (!u.userId || !u.facts?.length) {
          continue;
        }
        const existing = this.memoryService.getUserMemoryTextByLayer(groupId, u.userId, 'auto');
        const newFactsText = u.facts.join('\n');
        const merged = await this.mergeWithExisting(existing, newFactsText, 'user', options);
        if (merged) {
          await this.memoryService.upsertMemory(groupId, u.userId, false, merged, 'auto', 'llm_extract');
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

  /** memory/extract prompt returns JSON (group_facts, user_facts); code block or raw. */
  private static readonly EXTRACT_JSON_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

  /**
   * Parse extract output: group_facts and user_facts[].facts can be string[] or Array<{ scope, content }>.
   */
  private parseExtractOutput(text: string): ExtractResult | null {
    try {
      const jsonStr = extractJsonFromLlmText(text, {
        strategies: MemoryExtractService.EXTRACT_JSON_STRATEGIES,
      });
      if (jsonStr == null) {
        return null;
      }
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
