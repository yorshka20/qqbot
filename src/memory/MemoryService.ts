// Memory Service - file-based persistence for group and user memories (like prompt templates)
// Supports optional RAG-based semantic search for context-aware memory filtering
// Supports hierarchical scopes: [core_scope:subtag] format (e.g., [preference:food])

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ALL_CORE_SCOPES, type ParsedScope } from '@/core/config/types/memory';
import { logger } from '@/utils/logger';
import type { MemoryRAGService } from './MemoryRAGService';

/** User ID used for group-level memory slot (one file per group: _global_.txt). */
export const GROUP_MEMORY_USER_ID = '_global_memory_';

/** Default max length for content to avoid exceeding prompt limits. */
const DEFAULT_MAX_CONTENT_LENGTH = 100_000;

/** Default base directory for memory files (relative to cwd). Overridden by config. */
const DEFAULT_MEMORY_DIR = 'data/memory';

/** Filename for group-level memory inside a group directory. */
const GROUP_MEMORY_FILENAME = '_global_.txt';

export interface MemoryServiceOptions {
  /** Base directory for memory files (resolved with process.cwd()). Default "data/memory". */
  memoryDir?: string;
  /** Max length for memory content (truncate if exceeded). */
  maxContentLength?: number;
}

export interface MemorySearchResult {
  userId: string;
  isGroupMemory: boolean;
  snippet: string;
  content: string;
}

/** Parsed memory section with scope and content */
export interface MemorySection {
  /** Full scope string (e.g., 'preference:food' or 'identity') */
  scope: string;
  /** Parsed hierarchical scope info */
  parsedScope: ParsedScope;
  /** The content of this section */
  content: string;
}

/** Options for context-aware memory filtering */
export interface MemoryFilterOptions {
  /** User message or query for relevance matching */
  userMessage: string;
  /** Scopes that are always included regardless of relevance (default: ['instruction', 'rule']) */
  alwaysIncludeScopes?: string[];
  /** Minimum keyword match score (0-1) to include a section (default: 0.1) */
  minRelevanceScore?: number;
}

/** Result of context-aware memory filtering */
export interface FilteredMemoryResult {
  groupMemoryText: string;
  userMemoryText: string;
  /** Number of sections included vs total */
  stats: {
    groupIncluded: number;
    groupTotal: number;
    userIncluded: number;
    userTotal: number;
  };
}

/**
 * File-backed memory: one directory per groupId, group memory in _global_.txt, user memory in {userId}.txt.
 * No in-memory cache so manual edits to files are visible on next read.
 * Supports optional RAG-based semantic search when MemoryRAGService is configured.
 */
export class MemoryService {
  private readonly basePath: string;
  private readonly maxContentLength: number;
  private ragService: MemoryRAGService | null = null;

  constructor(options: MemoryServiceOptions = {}) {
    const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;
    this.basePath = join(process.cwd(), memoryDir);
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Set the RAG service for semantic memory search.
   * Should be called during initialization when RAG is enabled.
   */
  setRAGService(ragService: MemoryRAGService): void {
    this.ragService = ragService;
    logger.info('[MemoryService] RAG service configured for semantic memory search');
  }

  /**
   * Check if RAG-based semantic search is available
   */
  isRAGEnabled(): boolean {
    return this.ragService?.isEnabled() ?? false;
  }

  /**
   * Resolve file path for a memory slot. Group memory uses _global_.txt; user memory uses {userId}.txt.
   * Sanitizes groupId and userId to avoid path traversal (only alphanumeric and underscore allowed; else replaced with _).
   */
  private getFilePath(groupId: string, userId: string): string {
    const safeGroupId = this.sanitizePathSegment(groupId);
    const filename =
      userId === GROUP_MEMORY_USER_ID ? GROUP_MEMORY_FILENAME : `${this.sanitizePathSegment(userId)}.txt`;
    return join(this.basePath, safeGroupId, filename);
  }

  /** Allow only alphanumeric and underscore; replace other chars with _. */
  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Get group-level memory text for a group (file: {memoryDir}/{groupId}/_global_.txt).
   */
  getGroupMemoryText(groupId: string): string {
    const path = this.getFilePath(groupId, GROUP_MEMORY_USER_ID);
    try {
      const content = readFileSync(path, 'utf-8');
      return content ?? '';
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ENOENT') {
        return '';
      }
      logger.warn('[MemoryService] getGroupMemoryText read failed:', path, err);
      return '';
    }
  }

  /**
   * Get user-in-group memory text for (groupId, userId).
   */
  getUserMemoryText(groupId: string, userId: string): string {
    const path = this.getFilePath(groupId, userId);
    try {
      const content = readFileSync(path, 'utf-8');
      return content ?? '';
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ENOENT') {
        return '';
      }
      logger.warn('[MemoryService] getUserMemoryText read failed:', path, err);
      return '';
    }
  }

  /**
   * Get both group and user memory texts for reply injection.
   * Group memory is always returned; user memory only when userId is provided.
   */
  getMemoryTextForReply(groupId: string, userId?: string): { groupMemoryText: string; userMemoryText: string } {
    const groupMemoryText = this.getGroupMemoryText(groupId);
    const userMemoryText = userId ? this.getUserMemoryText(groupId, userId) : '';
    return { groupMemoryText, userMemoryText };
  }

  /**
   * Get one memory slot directly. When userId is omitted, returns group memory.
   */
  getMemory(groupId: string, userId?: string): { userId: string; isGroupMemory: boolean; content: string } {
    const targetUserId = userId?.trim() ? userId.trim() : GROUP_MEMORY_USER_ID;
    const isGroupMemory = targetUserId === GROUP_MEMORY_USER_ID;
    const content = isGroupMemory ? this.getGroupMemoryText(groupId) : this.getUserMemoryText(groupId, targetUserId);
    return {
      userId: targetUserId,
      isGroupMemory,
      content,
    };
  }

  /**
   * Search memories within one group. By default searches both group memory and all user memories.
   */
  searchMemories(
    groupId: string,
    query: string,
    options?: {
      userId?: string;
      includeGroupMemory?: boolean;
      limit?: number;
    },
  ): MemorySearchResult[] {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) {
      return [];
    }

    const safeGroupId = this.sanitizePathSegment(groupId);
    const groupDir = join(this.basePath, safeGroupId);
    if (!existsSync(groupDir)) {
      return [];
    }

    const includeGroupMemory = options?.includeGroupMemory !== false;
    const specificUserId = options?.userId?.trim();
    const limit = Math.max(1, options?.limit ?? 10);
    const results: MemorySearchResult[] = [];

    const candidateUserIds = specificUserId
      ? [specificUserId]
      : readdirSync(groupDir)
          .filter((entry) => entry.endsWith('.txt'))
          .map((entry) => entry.replace(/\.txt$/, ''))
          .filter((entry) => entry !== GROUP_MEMORY_FILENAME.replace(/\.txt$/, ''));

    if (includeGroupMemory) {
      const groupContent = this.getGroupMemoryText(groupId);
      const snippet = this.extractSnippet(groupContent, trimmedQuery);
      if (snippet) {
        results.push({
          userId: GROUP_MEMORY_USER_ID,
          isGroupMemory: true,
          snippet,
          content: groupContent,
        });
      }
    }

    for (const userId of candidateUserIds) {
      const content = this.getUserMemoryText(groupId, userId);
      const snippet = this.extractSnippet(content, trimmedQuery);
      if (!snippet) {
        continue;
      }
      results.push({
        userId,
        isGroupMemory: false,
        snippet,
        content,
      });
      if (results.length >= limit) {
        break;
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Truncate content to max length.
   * todo: use llm to summarize.
   */
  private truncate(content: string): string {
    if (content.length <= this.maxContentLength) {
      return content;
    }
    return content.slice(0, this.maxContentLength);
  }

  private extractSnippet(content: string, queryLower: string): string | null {
    if (!content) {
      return null;
    }
    const lower = content.toLowerCase();
    const index = lower.indexOf(queryLower);
    if (index === -1) {
      return null;
    }
    const start = Math.max(0, index - 60);
    const end = Math.min(content.length, index + queryLower.length + 120);
    return content.slice(start, end).trim();
  }

  /**
   * Upsert one memory slot by (groupId, userId). Writes to file; creates directory if needed.
   * Use GROUP_MEMORY_USER_ID for group-level memory.
   * Empty content is written as an empty file so the slot exists and can be edited manually.
   * If RAG is enabled, also indexes the memory sections for semantic search.
   */
  async upsertMemory(groupId: string, userId: string, _isGlobalMemory: boolean, content: string): Promise<void> {
    const trimmed = this.truncate(content.trim());

    const path = this.getFilePath(groupId, userId);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, trimmed, 'utf-8');

      // Index to RAG if enabled (fire-and-forget, don't block on RAG errors)
      if (this.ragService?.isEnabled()) {
        const sections = this.parseMemorySections(trimmed);
        this.ragService.indexMemorySections(groupId, userId, sections).catch((err) => {
          logger.warn('[MemoryService] RAG indexing failed (non-blocking):', err instanceof Error ? err.message : err);
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown');
      logger.error('[MemoryService] upsertMemory failed:', path, err);
      throw err;
    }
  }

  // ============================================================================
  // Hierarchical scope parsing
  // ============================================================================

  /**
   * Parse a scope string into hierarchical components.
   * Supports formats: 'core_scope' or 'core_scope:subtag'
   * Examples: 'identity' -> { core: 'identity', full: 'identity' }
   *           'preference:food' -> { core: 'preference', subtag: 'food', full: 'preference:food' }
   */
  parseScope(scopeStr: string): ParsedScope {
    const normalized = scopeStr.trim().toLowerCase();
    const colonIndex = normalized.indexOf(':');

    if (colonIndex === -1) {
      return { core: normalized, full: normalized };
    }

    const core = normalized.slice(0, colonIndex);
    const subtag = normalized.slice(colonIndex + 1);
    return { core, subtag: subtag || undefined, full: normalized };
  }

  /**
   * Check if a scope's core part is a known core scope.
   * Useful for validation during extraction.
   */
  isValidCoreScope(scope: string | ParsedScope): boolean {
    const core = typeof scope === 'string' ? this.parseScope(scope).core : scope.core;
    return ALL_CORE_SCOPES.includes(core as (typeof ALL_CORE_SCOPES)[number]);
  }

  /**
   * Extract all unique scopes from memory text.
   * Returns both full scopes and their parsed components.
   * Useful for providing existing scopes to AI during memory merge.
   */
  extractAllScopes(memoryText: string): ParsedScope[] {
    const sections = this.parseMemorySections(memoryText);
    const seen = new Set<string>();
    const scopes: ParsedScope[] = [];

    for (const section of sections) {
      if (!seen.has(section.parsedScope.full)) {
        seen.add(section.parsedScope.full);
        scopes.push(section.parsedScope);
      }
    }

    return scopes;
  }

  /**
   * Get all existing scopes for a group (both group and user memory).
   * Used to provide scope vocabulary to AI during memory extraction/merge.
   */
  getAllExistingScopes(groupId: string, userId?: string): { groupScopes: ParsedScope[]; userScopes: ParsedScope[] } {
    const groupMemory = this.getGroupMemoryText(groupId);
    const groupScopes = this.extractAllScopes(groupMemory);

    let userScopes: ParsedScope[] = [];
    if (userId) {
      const userMemory = this.getUserMemoryText(groupId, userId);
      userScopes = this.extractAllScopes(userMemory);
    }

    return { groupScopes, userScopes };
  }

  // ============================================================================
  // Context-aware memory filtering
  // ============================================================================

  /**
   * Parse memory content into sections by [scope] tags.
   * Memory format: [scope]\ncontent\n\n[scope2]\ncontent2...
   * Supports hierarchical scopes: [core:subtag]
   */
  parseMemorySections(memoryText: string): MemorySection[] {
    if (!memoryText.trim()) {
      return [];
    }

    const sections: MemorySection[] = [];
    // Match [scope] or [scope:subtag] followed by content until next [scope] or end
    const sectionRegex = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\[|\s*$)/g;
    const matches = memoryText.matchAll(sectionRegex);

    for (const match of matches) {
      const scopeStr = match[1].trim();
      const content = match[2].trim();
      if (content) {
        const parsedScope = this.parseScope(scopeStr);
        sections.push({ scope: parsedScope.full, parsedScope, content });
      }
    }

    return sections;
  }

  /**
   * Get context-aware filtered memory for reply injection.
   * Uses RAG semantic search when available, falls back to keyword matching.
   *
   * @param groupId - Group ID
   * @param userId - Optional user ID for user-specific memory
   * @param options - Filter options including user message for relevance matching
   * @returns Filtered memory text for both group and user
   */
  /**
   * Get context-aware filtered memory for reply injection.
   * Uses RAG semantic search when available, falls back to returning all memory.
   */
  async getFilteredMemoryForReplyAsync(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): Promise<FilteredMemoryResult> {
    // RAG is required for memory injection — without it, skip to save tokens
    if (!this.ragService?.isEnabled() || !options.userMessage.trim()) {
      logger.debug('[MemoryService] RAG not available or empty query, skipping memory injection');
      return {
        groupMemoryText: '',
        userMemoryText: '',
        stats: { groupIncluded: 0, groupTotal: 0, userIncluded: 0, userTotal: 0 },
      };
    }

    try {
      const ragResult = await this.getFilteredMemoryWithRAG(groupId, userId, options);
      logger.debug(
        `[MemoryService] RAG filtered memory: group ${ragResult.stats.groupIncluded}/${ragResult.stats.groupTotal}, ` +
          `user ${ragResult.stats.userIncluded}/${ragResult.stats.userTotal}`,
      );
      return ragResult;
    } catch (err) {
      logger.warn('[MemoryService] RAG search failed, skipping memory injection:', err);
      return {
        groupMemoryText: '',
        userMemoryText: '',
        stats: { groupIncluded: 0, groupTotal: 0, userIncluded: 0, userTotal: 0 },
      };
    }
  }

  /**
   * RAG-based memory filtering using semantic search.
   * ALL memory is fetched from RAG - markdown files are NOT read at runtime.
   * Always-include scopes are fetched via payload filter (scroll), other scopes via vector search.
   */
  private async getFilteredMemoryWithRAG(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): Promise<FilteredMemoryResult> {
    if (!this.ragService) {
      throw new Error('RAG service not configured');
    }

    const alwaysIncludeScopes = options.alwaysIncludeScopes ?? ['instruction', 'rule'];
    const minScore = options.minRelevanceScore ?? 0.5;

    // Fetch always-include scopes from RAG via payload filter (no vector search)
    const alwaysIncludeResults = await this.ragService.getFactsByCoreScopes(groupId, alwaysIncludeScopes, {
      userId,
      includeGroupMemory: true,
    });

    // Format always-include results
    const { groupMemoryText: alwaysGroupText, userMemoryText: alwaysUserText } =
      this.ragService.formatResultsAsMemoryText(alwaysIncludeResults);

    // Search for semantically relevant facts (fine-grained vector search)
    const searchResults = await this.ragService.searchRelevantFacts(groupId, options.userMessage, {
      userId,
      includeGroupMemory: true,
      limit: 15,
      minScore,
    });

    // Filter out facts from always-include scopes (already fetched above)
    const relevantResults = searchResults.filter((r) => {
      const parsedScope = this.parseScope(r.fact.scope);
      return !alwaysIncludeScopes.includes(r.fact.scope) && !alwaysIncludeScopes.includes(parsedScope.core);
    });

    // Format vector search results
    const { groupMemoryText: ragGroupText, userMemoryText: ragUserText } =
      this.ragService.formatResultsAsMemoryText(relevantResults);

    // Combine always-include with RAG results
    const groupParts: string[] = [];
    const userParts: string[] = [];

    if (alwaysGroupText) {
      groupParts.push(alwaysGroupText);
    }
    if (alwaysUserText) {
      userParts.push(alwaysUserText);
    }
    if (ragGroupText) {
      groupParts.push(ragGroupText);
    }
    if (ragUserText) {
      userParts.push(ragUserText);
    }

    const groupMemoryText = groupParts.join('\n\n');
    const userMemoryText = userParts.join('\n\n');

    // Count included facts for stats
    const alwaysGroupCount = alwaysIncludeResults.filter((r) => r.isGroupMemory).length;
    const alwaysUserCount = alwaysIncludeResults.filter((r) => !r.isGroupMemory).length;
    const relevantGroupCount = relevantResults.filter((r) => r.isGroupMemory).length;
    const relevantUserCount = relevantResults.filter((r) => !r.isGroupMemory).length;

    return {
      groupMemoryText,
      userMemoryText,
      stats: {
        groupIncluded: alwaysGroupCount + relevantGroupCount,
        groupTotal: alwaysGroupCount + relevantGroupCount, // Total from RAG perspective
        userIncluded: alwaysUserCount + relevantUserCount,
        userTotal: alwaysUserCount + relevantUserCount,
      },
    };
  }

  // ============================================================================
  // RAG sync
  // ============================================================================

  /**
   * Re-sync local markdown memory files for a group to Qdrant.
   * Deletes old RAG data per-user/group slot before re-indexing.
   *
   * @param groupId - Group ID
   * @param target - 'all' syncs everything, 'group' syncs only group memory, 'user' syncs a specific user
   * @param userId - Required when target is 'user'
   */
  async syncMemoryToRAG(
    groupId: string,
    target: 'all' | 'group' | 'user' = 'all',
    userId?: string,
  ): Promise<{ groupSynced: boolean; usersSynced: string[]; totalFacts: number }> {
    if (!this.ragService?.isEnabled()) {
      throw new Error('RAG service is not available');
    }

    const safeGroupId = this.sanitizePathSegment(groupId);
    const groupDir = join(this.basePath, safeGroupId);
    let totalFacts = 0;
    let groupSynced = false;
    const usersSynced: string[] = [];

    // Sync group memory
    if (target === 'all' || target === 'group') {
      const groupText = this.getGroupMemoryText(groupId);
      const groupSections = this.parseMemorySections(groupText);
      await this.ragService.indexMemorySections(groupId, GROUP_MEMORY_USER_ID, groupSections);
      groupSynced = groupSections.length > 0;
      totalFacts += groupSections.length;
    }

    // Sync user memories
    if (target === 'all' || target === 'user') {
      const targetUserIds =
        target === 'user' && userId
          ? [userId]
          : existsSync(groupDir)
            ? readdirSync(groupDir)
                .filter((f) => f.endsWith('.txt') && f !== '_global_.txt')
                .map((f) => f.replace(/\.txt$/, ''))
            : [];

      for (const uid of targetUserIds) {
        const userText = this.getUserMemoryText(groupId, uid);
        const userSections = this.parseMemorySections(userText);
        await this.ragService.indexMemorySections(groupId, uid, userSections);
        if (userSections.length > 0) {
          usersSynced.push(uid);
          totalFacts += userSections.length;
        }
      }
    }

    logger.info(
      `[MemoryService] RAG sync completed for group ${groupId} (target=${target}): ` +
        `group=${groupSynced ? 'synced' : 'skipped/empty'}, ` +
        `users=${usersSynced.length}, totalFacts=${totalFacts}`,
    );

    return { groupSynced, usersSynced, totalFacts };
  }
}
