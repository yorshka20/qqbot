// PreferenceKnowledgeService - RAG retrieval for proactive reply (Phase 2)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { SearchResult, SearchService } from '@/search';
import { logger } from '@/utils/logger';

export interface PreferenceKnowledgeRetrieveOptions {
  /** Max number of chunks to return. Default implementation may ignore. */
  limit?: number;
  /** Pre-decided search queries from analysis stage. When non-empty, execute these only (no LLM in retrieve). Empty array = no search. */
  searchQueries?: string[];
}

/**
 * Service to retrieve knowledge chunks for a preference (persona) and query/topic.
 * Used by proactive reply flow to inject RAG context into the main LLM prompt.
 * Phase 2: default implementation returns empty array; real RAG can be wired later.
 */
export interface PreferenceKnowledgeService {
  /**
   * Retrieve relevant knowledge chunks for the given preference and query/topic.
   * @param preferenceKey - e.g. "preference.tech_expert"
   * @param queryOrTopic - topic or short query (e.g. from Ollama analysis or recent messages)
   * @param options - optional e.g. limit
   * @returns Array of text chunks (may be empty)
   */
  retrieve(
    preferenceKey: string,
    queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]>;
}

/**
 * Default implementation: no RAG backend, always returns empty array.
 * Replace with a real implementation (e.g. vector store) when knowledge base is ready.
 */
export class DefaultPreferenceKnowledgeService implements PreferenceKnowledgeService {
  async retrieve(
    _preferenceKey: string,
    _queryOrTopic: string,
    _options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    return [];
  }
}

/**
 * Format search results into chunk strings (title + snippet + url).
 */
function resultsToChunks(results: SearchResult[], snippetMaxLen = 400): string[] {
  return results.map((r) => {
    const snippet = (r.snippet || r.content || '').trim().substring(0, snippetMaxLen);
    return `**${r.title || '无标题'}**\n${snippet ? `摘要: ${snippet}\n` : ''}链接: ${r.url || ''}`.trim();
  });
}

/**
 * SearXNG-based implementation: uses SearchService to run web search.
 * Search decision (whether/what to search) is done at analysis stage.
 * After first retrieve, one short LLM check: if information insufficient, run one supplement search (option B).
 */
export class SearXNGPreferenceKnowledgeService implements PreferenceKnowledgeService {
  constructor(
    private readonly searchService: SearchService,
    private readonly llmService: LLMService,
    private readonly promptManager: PromptManager,
  ) { }

  async retrieve(
    preferenceKey: string,
    queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    if (!this.searchService?.isEnabled()) {
      logger.debug('[SearXNGPreferenceKnowledgeService] SearchService not enabled, skipping search');
      return [];
    }

    const limit = options?.limit ?? 8;

    const searchQueries = options?.searchQueries;
    if (!searchQueries || searchQueries.length === 0) {
      return [];
    }

    let chunks = await this.executeQueries(preferenceKey, searchQueries, limit);

    if (chunks.length > 0 && this.llmService && this.promptManager) {
      const extra = await this.checkSufficiencyAndMaybeSupplement(
        queryOrTopic.trim() || '当前话题',
        chunks,
        limit,
      );
      if (extra.length > 0) {
        chunks = [...chunks, ...extra];
      }
    }

    const capped = chunks.slice(0, limit);
    logger.debug(
      `[SearXNGPreferenceKnowledgeService] Retrieved ${capped.length} chunks for preferenceKey=${preferenceKey}`,
    );
    return capped;
  }

  /**
   * Short LLM check: is retrieved knowledge sufficient? If not, return chunks from one supplement search.
   */
  private async checkSufficiencyAndMaybeSupplement(
    topic: string,
    chunks: string[],
    limit: number,
  ): Promise<string[]> {
    const chunksSummary = chunks
      .map((c) => c.replace(/\n/g, ' ').trim().slice(0, 80))
      .join('\n');
    const summaryCapped = chunksSummary.slice(0, 400);


    const prompt = this.promptManager.render('llm.proactive_knowledge_sufficient', {
      topic,
      chunksSummary: summaryCapped || '(无)',
    });

    let responseText: string;
    try {
      const response = await this.llmService.generate(prompt, {
        temperature: 0.2,
        maxTokens: 150,
      });
      responseText = (response.text || '').trim();
    } catch (err) {
      logger.warn(
        `[SearXNGPreferenceKnowledgeService] Sufficiency LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const upper = responseText.toUpperCase();
    if (!upper.startsWith('SEARCH:')) {
      return [];
    }
    const supplementPart = responseText.slice(7).trim();
    if (!supplementPart) {
      return [];
    }
    const supplementQueries = supplementPart
      .split('|')
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    if (supplementQueries.length === 0) {
      return [];
    }

    logger.debug(
      `[SearXNGPreferenceKnowledgeService] Sufficiency check: supplementing with ${supplementQueries.length} query/queries`,
    );
    const room = Math.max(0, limit - chunks.length);
    const perQueryLimit = Math.max(2, Math.ceil(room / supplementQueries.length));
    const extraChunks: string[] = [];
    for (const q of supplementQueries) {
      try {
        const results = await this.searchService.search(q, { maxResults: perQueryLimit });
        extraChunks.push(...resultsToChunks(results));
      } catch (err) {
        logger.warn(
          `[SearXNGPreferenceKnowledgeService] Supplement search failed for "${q.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return extraChunks;
  }

  /** Execute a list of search queries once and return combined chunks (no LLM). */
  private async executeQueries(
    preferenceKey: string,
    queries: string[],
    limit: number,
  ): Promise<string[]> {
    const allChunks: string[] = [];
    const perQueryLimit = Math.max(2, Math.ceil(limit / queries.length));
    for (const query of queries) {
      try {
        const results = await this.searchService!.search(query.trim(), { maxResults: perQueryLimit });
        allChunks.push(...resultsToChunks(results));
      } catch (err) {
        logger.warn(
          `[SearXNGPreferenceKnowledgeService] Search failed for query "${query.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    logger.debug(
      `[SearXNGPreferenceKnowledgeService] First pass: ${allChunks.length} chunks (analysis-decided queries) for preferenceKey=${preferenceKey}`,
    );
    return allChunks;
  }
}
