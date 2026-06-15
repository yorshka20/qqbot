// Memory Extract Service - extract from messages, merge with existing via analyze, then upsert
// Supports hierarchical scopes: [core_scope:subtag] format

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import type { Config } from '@/core/config';
import { GROUP_CORE_SCOPES, type ParsedScope, USER_CORE_SCOPES } from '@/core/config/types/memory';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryNoteBuffer } from '@/database/models/types';
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

  /** Per-group debounce timers for draining buffered memory notes (from the `memory_note` tool). */
  private noteFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Debounce delay before a buffered note is consolidated. The note takes effect at this next
   * consolidation pass (not immediately) — long enough that it is clearly a consolidation step,
   * short enough that notes do not linger unmerged.
   */
  private static readonly NOTE_FLUSH_DEBOUNCE_MS = 5 * 60 * 1000;

  constructor(
    private promptManager: PromptManager,
    private llmService: LLMService,
    private memoryService: MemoryService,
    private databaseManager: DatabaseManager,
    private config: Config,
  ) {}

  // ============================================================================
  // Memory note buffer (memory_note tool): stage user rules, drain at consolidation
  // ============================================================================

  /** Pending-notes model accessor, or null when the database is unavailable. */
  private getNotesModel() {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return null;
    }
    try {
      return adapter.getModel('memoryNotesBuffer');
    } catch {
      return null;
    }
  }

  /** LLM provider for note consolidation: same as memory extract (taskProviders.memoryExtract → defaultProviders.llm). */
  private resolveProvider(): string | null {
    const ai = this.config.getAIConfig();
    return ai?.taskProviders?.memoryExtract ?? ai?.defaultProviders?.llm ?? null;
  }

  /**
   * Stage an explicit user rule/requirement into the note buffer and schedule a debounced flush.
   * Does NOT write memory directly — the buffer is the single source consumed once by consolidation.
   * userId === GROUP_MEMORY_USER_ID routes to group memory; otherwise to that user's memory.
   * Returns false if the database is unavailable.
   */
  async addNote(groupId: string, userId: string, content: string, scope?: string): Promise<boolean> {
    const model = this.getNotesModel();
    if (!model) {
      return false;
    }
    await model.create({
      groupId,
      userId,
      scope: scope?.trim() || undefined,
      content: content.trim(),
      status: 'pending',
    } as Omit<MemoryNoteBuffer, 'id' | 'createdAt' | 'updatedAt'>);
    this.scheduleFlush(groupId);
    return true;
  }

  /** Schedule a debounced note flush for a group; resets the timer on each new note. */
  private scheduleFlush(groupId: string): void {
    const existing = this.noteFlushTimers.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.noteFlushTimers.delete(groupId);
      void this.flushNotes(groupId);
    }, MemoryExtractService.NOTE_FLUSH_DEBOUNCE_MS);
    this.noteFlushTimers.set(groupId, timer);
  }

  /**
   * Drain pending notes for a group and consolidate them into memory (notes only, no extraction).
   * Queued behind any running extract/analyze job so drains never race.
   */
  async flushNotes(groupId: string): Promise<void> {
    const prev = this.extractQueue;
    this.extractQueue = prev.then(() => this.runFlushNotes(groupId));
    return this.extractQueue;
  }

  private async runFlushNotes(groupId: string): Promise<void> {
    const provider = this.resolveProvider();
    if (!provider) {
      logger.warn('[MemoryExtractService] flushNotes: no LLM provider configured, skip');
      return;
    }
    const drained = await this.drainPendingNotes(groupId);
    if (!drained || (drained.groupNotes.length === 0 && drained.userNotes.size === 0)) {
      return;
    }
    try {
      await this.consolidateSlots(groupId, drained.groupNotes, drained.userNotes, { provider });
      await this.deletePendingNotes(drained.ids);
      logger.info(`[MemoryExtractService] flushed ${drained.ids.length} memory notes | group=${groupId}`);
    } catch (err) {
      logger.error('[MemoryExtractService] flushNotes failed (notes kept for retry):', err);
    }
  }

  /** Read pending notes for a group, formatted and routed by slot. Returns null if DB unavailable. */
  private async drainPendingNotes(
    groupId: string,
  ): Promise<{ groupNotes: string[]; userNotes: Map<string, string[]>; ids: string[] } | null> {
    const model = this.getNotesModel();
    if (!model) {
      return null;
    }
    const pending = await model.find({ groupId, status: 'pending' } as Partial<MemoryNoteBuffer>);
    const groupNotes: string[] = [];
    const userNotes = new Map<string, string[]>();
    const ids: string[] = [];
    for (const note of pending) {
      const fact = this.formatNote(note);
      if (!fact) {
        continue;
      }
      ids.push(note.id);
      if (note.userId === GROUP_MEMORY_USER_ID) {
        groupNotes.push(fact);
      } else {
        const arr = userNotes.get(note.userId) ?? [];
        arr.push(fact);
        userNotes.set(note.userId, arr);
      }
    }
    return { groupNotes, userNotes, ids };
  }

  /** Format a note as "[scope] content" (or plain content), matching extract fact format. */
  private formatNote(note: MemoryNoteBuffer): string | null {
    const content = note.content?.trim();
    if (!content) {
      return null;
    }
    const scope = note.scope?.trim();
    return scope ? `[${scope}] ${content}` : content;
  }

  private async deletePendingNotes(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const model = this.getNotesModel();
    if (!model) {
      return;
    }
    for (const id of ids) {
      await model.delete(id);
    }
  }

  /**
   * Merge facts into the group-global slot and each user slot (auto layer), one mergeWithExisting per slot.
   * Shared by note flush and the periodic extract path so notes and extracted facts collapse together.
   */
  private async consolidateSlots(
    groupId: string,
    groupFacts: string[],
    userFacts: Map<string, string[]>,
    options: MemoryExtractServiceOptions,
  ): Promise<void> {
    if (groupFacts.length > 0) {
      const existing = this.memoryService.getGroupMemoryTextByLayer(groupId, 'auto');
      const merged = await this.mergeWithExisting(existing, groupFacts.join('\n'), 'global', options);
      if (merged) {
        await this.memoryService.upsertMemory(groupId, GROUP_MEMORY_USER_ID, true, merged, 'auto', 'llm_extract');
      }
      logger.info(`[MemoryExtractService] memory updated | group=${groupId} target=GROUP_GLOBAL |\n${merged}`);
    }
    for (const [userId, facts] of userFacts) {
      if (!userId || facts.length === 0) {
        continue;
      }
      const existing = this.memoryService.getUserMemoryTextByLayer(groupId, userId, 'auto');
      const merged = await this.mergeWithExisting(existing, facts.join('\n'), 'user', options);
      if (merged) {
        await this.memoryService.upsertMemory(groupId, userId, false, merged, 'auto', 'llm_extract');
      }
      logger.info(`[MemoryExtractService] memory updated | group=${groupId} user=${userId} |\n${merged}`);
    }
  }

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

    // Even when extraction yields nothing, still drain buffered notes for this group so they consolidate.
    const parsed = this.parseExtractOutput(response);

    const groupFacts: string[] = [...(parsed?.groupFacts ?? [])];
    const userFacts = new Map<string, string[]>();
    for (const u of parsed?.userFacts ?? []) {
      if (!u.userId || !u.facts?.length) {
        continue;
      }
      const arr = userFacts.get(u.userId) ?? [];
      arr.push(...u.facts);
      userFacts.set(u.userId, arr);
    }

    // Fold buffered notes (from memory_note) into the same merge so they collapse with extracted facts.
    const drained = await this.drainPendingNotes(groupId);
    if (drained) {
      groupFacts.push(...drained.groupNotes);
      for (const [uid, facts] of drained.userNotes) {
        const arr = userFacts.get(uid) ?? [];
        arr.push(...facts);
        userFacts.set(uid, arr);
      }
    }

    if (groupFacts.length === 0 && userFacts.size === 0) {
      return;
    }

    logger.info(
      `[MemoryExtractService] extract done | group=${groupId} | group_facts=${groupFacts.length} user_facts_users=[${[...userFacts.keys()].join(',')}] notes=${drained?.ids.length ?? 0}`,
    );

    try {
      await this.consolidateSlots(groupId, groupFacts, userFacts, options);
      if (drained) {
        await this.deletePendingNotes(drained.ids);
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
