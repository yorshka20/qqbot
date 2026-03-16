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
  /** Maximum total character length for filtered memory (default: 2000) */
  maxLength?: number;
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
   * Extract keywords from user message for relevance matching.
   * Removes common stop words and short tokens.
   */
  private extractKeywords(text: string): string[] {
    // Chinese and English stop words
    const stopWords = new Set([
      // Chinese common words
      '的',
      '了',
      '是',
      '在',
      '我',
      '有',
      '和',
      '就',
      '不',
      '人',
      '都',
      '一',
      '一个',
      '上',
      '也',
      '很',
      '到',
      '说',
      '要',
      '去',
      '你',
      '会',
      '着',
      '没有',
      '看',
      '好',
      '自己',
      '这',
      '那',
      '什么',
      '吗',
      '吧',
      '呢',
      '啊',
      '嗯',
      '哦',
      '呀',
      '啦',
      '哈',
      '嘿',
      '喂',
      '哎',
      '唉',
      '诶',
      '可以',
      '怎么',
      '这个',
      '那个',
      '还是',
      '但是',
      '因为',
      '所以',
      '如果',
      '虽然',
      '或者',
      '而且',
      '然后',
      '现在',
      '已经',
      '可能',
      '应该',
      '需要',
      '想要',
      '知道',
      '觉得',
      '感觉',
      '希望',
      '帮',
      '帮我',
      '请',
      '请问',
      '谢谢',
      '好的',
      '没问题',
      // English common words
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'can',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'not',
      'only',
      'own',
      'same',
      'so',
      'than',
      'too',
      'very',
      'just',
      'and',
      'but',
      'if',
      'or',
      'because',
      'until',
      'while',
      'it',
      'its',
      'i',
      'me',
      'my',
      'myself',
      'we',
      'our',
      'ours',
      'you',
      'your',
      'yours',
      'he',
      'him',
      'his',
      'she',
      'her',
      'hers',
      'they',
      'them',
      'their',
      'what',
      'which',
      'who',
      'whom',
      'this',
      'that',
      'these',
      'those',
      'am',
      'about',
      'get',
      'got',
      'want',
      'please',
      'thanks',
      'thank',
      'help',
      'ok',
      'okay',
      'yes',
      'no',
      'yeah',
      'yep',
      'nope',
    ]);

    // Tokenize: split by whitespace and punctuation, keep Chinese characters together
    const tokens: string[] = [];

    // Extract Chinese character sequences
    const chineseMatches = text.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const match of chineseMatches) {
      // Split long Chinese sequences into 2-4 character segments for better matching
      if (match.length <= 4) {
        tokens.push(match);
      } else {
        // Sliding window for longer sequences
        for (let i = 0; i < match.length - 1; i++) {
          tokens.push(match.slice(i, i + 2));
          if (i < match.length - 2) {
            tokens.push(match.slice(i, i + 3));
          }
        }
      }
    }

    // Extract English words
    const englishMatches = text.match(/[a-zA-Z]+/g) || [];
    tokens.push(...englishMatches.map((w) => w.toLowerCase()));

    // Filter stop words and short tokens
    return tokens.filter((token) => token.length >= 2 && !stopWords.has(token.toLowerCase()));
  }

  /**
   * Calculate relevance score between keywords and a text section.
   * Returns a score from 0 to 1.
   */
  private calculateRelevanceScore(keywords: string[], sectionContent: string): number {
    if (keywords.length === 0) {
      return 0;
    }

    const contentLower = sectionContent.toLowerCase();
    let matchCount = 0;

    for (const keyword of keywords) {
      if (contentLower.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }

    return matchCount / keywords.length;
  }

  /**
   * Check if a section should be always included based on its scope.
   * Matches against both full scope and core scope (e.g., 'instruction' matches 'instruction:special').
   */
  private shouldAlwaysInclude(section: MemorySection, alwaysIncludeScopes: string[]): boolean {
    // Check full scope match (e.g., 'instruction:special')
    if (alwaysIncludeScopes.includes(section.scope)) {
      return true;
    }
    // Check core scope match (e.g., 'instruction' matches 'instruction:special')
    if (alwaysIncludeScopes.includes(section.parsedScope.core)) {
      return true;
    }
    return false;
  }

  /**
   * Filter memory sections based on relevance to user message.
   * Always includes scopes like 'instruction' and 'rule' (matches core scope too).
   */
  private filterSectionsByRelevance(
    sections: MemorySection[],
    keywords: string[],
    options: {
      alwaysIncludeScopes: string[];
      minRelevanceScore: number;
      maxLength: number;
    },
  ): MemorySection[] {
    const result: MemorySection[] = [];
    let currentLength = 0;

    // First pass: always-include scopes (matches both full and core scope)
    for (const section of sections) {
      if (this.shouldAlwaysInclude(section, options.alwaysIncludeScopes)) {
        const sectionText = `[${section.scope}]\n${section.content}`;
        if (currentLength + sectionText.length <= options.maxLength) {
          result.push(section);
          currentLength += sectionText.length + 2; // +2 for newlines
        }
      }
    }

    // Second pass: relevance-based filtering
    const scoredSections = sections
      .filter((section) => !this.shouldAlwaysInclude(section, options.alwaysIncludeScopes))
      .map((section) => ({
        section,
        score: this.calculateRelevanceScore(keywords, section.content),
      }))
      .filter((item) => item.score >= options.minRelevanceScore)
      .sort((a, b) => b.score - a.score);

    for (const { section } of scoredSections) {
      const sectionText = `[${section.scope}]\n${section.content}`;
      if (currentLength + sectionText.length <= options.maxLength) {
        result.push(section);
        currentLength += sectionText.length + 2;
      }
    }

    return result;
  }

  /**
   * Format filtered sections back to memory text format.
   */
  private formatSectionsToText(sections: MemorySection[]): string {
    if (sections.length === 0) {
      return '';
    }
    return sections.map((s) => `[${s.scope}]\n${s.content}`).join('\n\n');
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
  getFilteredMemoryForReply(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): FilteredMemoryResult {
    // Use RAG if available (async method, but we provide sync fallback)
    // The async version is preferred and should be used when possible
    return this.getFilteredMemoryForReplyKeyword(groupId, userId, options);
  }

  /**
   * Async version that uses RAG semantic search when available.
   * This is the preferred method for context-aware memory filtering.
   */
  async getFilteredMemoryForReplyAsync(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): Promise<FilteredMemoryResult> {
    // Try RAG-based semantic search first
    if (this.ragService?.isEnabled() && options.userMessage.trim()) {
      try {
        const ragResult = await this.getFilteredMemoryWithRAG(groupId, userId, options);
        if (ragResult.stats.groupIncluded > 0 || ragResult.stats.userIncluded > 0) {
          logger.debug(
            `[MemoryService] RAG filtered memory: group ${ragResult.stats.groupIncluded}/${ragResult.stats.groupTotal}, ` +
              `user ${ragResult.stats.userIncluded}/${ragResult.stats.userTotal}`,
          );
          return ragResult;
        }
        // RAG returned nothing, fall back to always-include scopes
        logger.debug('[MemoryService] RAG returned no results, using always-include scopes only');
      } catch (err) {
        logger.warn('[MemoryService] RAG search failed, falling back to keyword matching:', err);
      }
    }

    // Fall back to keyword-based filtering
    return this.getFilteredMemoryForReplyKeyword(groupId, userId, options);
  }

  /**
   * RAG-based memory filtering using semantic search.
   * Searches at fact level for fine-grained retrieval.
   * Requires ragService to be set and enabled.
   */
  private async getFilteredMemoryWithRAG(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): Promise<FilteredMemoryResult> {
    if (!this.ragService) {
      throw new Error('RAG service not configured');
    }

    const maxLength = options.maxLength ?? 2000;
    const alwaysIncludeScopes = options.alwaysIncludeScopes ?? ['instruction', 'rule'];
    const minScore = options.minRelevanceScore ?? 0.5;

    // Get all sections for stats and always-include handling
    const groupMemoryRaw = this.getGroupMemoryText(groupId);
    const groupSections = this.parseMemorySections(groupMemoryRaw);
    const userMemoryRaw = userId ? this.getUserMemoryText(groupId, userId) : '';
    const userSections = userId ? this.parseMemorySections(userMemoryRaw) : [];

    // Extract always-include sections (instruction, rule) - these are fully included
    // Matches both full scope and core scope (e.g., 'instruction' matches 'instruction:special')
    const alwaysIncludeGroup = groupSections.filter((s) => this.shouldAlwaysInclude(s, alwaysIncludeScopes));
    const alwaysIncludeUser = userSections.filter((s) => this.shouldAlwaysInclude(s, alwaysIncludeScopes));

    // Search for semantically relevant facts (fine-grained search)
    const searchResults = await this.ragService.searchRelevantFacts(groupId, options.userMessage, {
      userId,
      includeGroupMemory: true,
      limit: 15, // More results since these are individual facts
      minScore,
    });

    // Filter out facts from always-include scopes and format results
    // Check against both full scope and core scope
    const relevantResults = searchResults.filter((r) => {
      const parsedScope = this.parseScope(r.fact.scope);
      return !alwaysIncludeScopes.includes(r.fact.scope) && !alwaysIncludeScopes.includes(parsedScope.core);
    });

    // Use RAG service to format results, respecting length limit
    const { groupMemoryText: ragGroupText, userMemoryText: ragUserText } =
      this.ragService.formatResultsAsMemoryText(relevantResults);

    // Combine always-include with RAG results
    const groupParts: string[] = [];
    const userParts: string[] = [];
    let currentLength = 0;

    // Add always-include sections first
    for (const section of alwaysIncludeGroup) {
      const text = `[${section.scope}]\n${section.content}`;
      groupParts.push(text);
      currentLength += text.length;
    }
    for (const section of alwaysIncludeUser) {
      const text = `[${section.scope}]\n${section.content}`;
      userParts.push(text);
      currentLength += text.length;
    }

    // Add RAG results within budget
    if (ragGroupText && currentLength + ragGroupText.length <= maxLength) {
      groupParts.push(ragGroupText);
      currentLength += ragGroupText.length;
    }
    if (ragUserText && currentLength + ragUserText.length <= maxLength) {
      userParts.push(ragUserText);
    }

    const groupMemoryText = groupParts.join('\n\n');
    const userMemoryText = userParts.join('\n\n');

    // Count included facts for stats
    const includedGroupFacts = relevantResults.filter((r) => r.isGroupMemory).length;
    const includedUserFacts = relevantResults.filter((r) => !r.isGroupMemory).length;

    return {
      groupMemoryText,
      userMemoryText,
      stats: {
        groupIncluded: alwaysIncludeGroup.length + includedGroupFacts,
        groupTotal: groupSections.length,
        userIncluded: alwaysIncludeUser.length + includedUserFacts,
        userTotal: userSections.length,
      },
    };
  }

  /**
   * Keyword-based memory filtering (fallback when RAG is not available).
   */
  private getFilteredMemoryForReplyKeyword(
    groupId: string,
    userId: string | undefined,
    options: MemoryFilterOptions,
  ): FilteredMemoryResult {
    const maxLength = options.maxLength ?? 2000;
    const alwaysIncludeScopes = options.alwaysIncludeScopes ?? ['instruction', 'rule'];
    const minRelevanceScore = options.minRelevanceScore ?? 0.1;

    // Extract keywords from user message
    const keywords = this.extractKeywords(options.userMessage);

    // Parse and filter group memory
    const groupMemoryRaw = this.getGroupMemoryText(groupId);
    const groupSections = this.parseMemorySections(groupMemoryRaw);
    const filteredGroupSections = this.filterSectionsByRelevance(groupSections, keywords, {
      alwaysIncludeScopes,
      minRelevanceScore,
      maxLength: Math.floor(maxLength * 0.6),
    });

    // Parse and filter user memory
    let userSections: MemorySection[] = [];
    let filteredUserSections: MemorySection[] = [];
    if (userId) {
      const userMemoryRaw = this.getUserMemoryText(groupId, userId);
      userSections = this.parseMemorySections(userMemoryRaw);
      filteredUserSections = this.filterSectionsByRelevance(userSections, keywords, {
        alwaysIncludeScopes,
        minRelevanceScore,
        maxLength: Math.floor(maxLength * 0.4),
      });
    }

    const groupMemoryText = this.formatSectionsToText(filteredGroupSections);
    const userMemoryText = this.formatSectionsToText(filteredUserSections);

    // Log filtering stats
    if (groupSections.length > 0 || userSections.length > 0) {
      logger.debug(
        `[MemoryService] Keyword filtered memory: group ${filteredGroupSections.length}/${groupSections.length}, ` +
          `user ${filteredUserSections.length}/${userSections.length}, ` +
          `keywords: [${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '...' : ''}]`,
      );
    }

    return {
      groupMemoryText,
      userMemoryText,
      stats: {
        groupIncluded: filteredGroupSections.length,
        groupTotal: groupSections.length,
        userIncluded: filteredUserSections.length,
        userTotal: userSections.length,
      },
    };
  }
}
