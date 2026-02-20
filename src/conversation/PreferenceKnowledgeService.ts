// PreferenceKnowledgeService - RAG retrieval for proactive reply (Phase 2)

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
 * Search decision (whether to search and which keywords) is done at analysis stage;
 * retrieve() only executes pre-decided searchQueries or falls back to single query with queryOrTopic (no LLM here).
 */
export class SearXNGPreferenceKnowledgeService implements PreferenceKnowledgeService {
  constructor(private readonly searchService?: SearchService) { }

  async retrieve(
    preferenceKey: string,
    _queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    if (!this.searchService?.isEnabled()) {
      logger.debug('[SearXNGPreferenceKnowledgeService] SearchService not enabled, skipping search');
      return [];
    }

    const limit = options?.limit ?? 8;

    // Only execute when analysis stage provided searchQueries
    const searchQueries = options?.searchQueries;
    if (!searchQueries || searchQueries.length === 0) {
      return [];
    }
    return this.executeQueries(preferenceKey, searchQueries, limit);
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
    const capped = allChunks.slice(0, limit);
    logger.debug(
      `[SearXNGPreferenceKnowledgeService] Retrieved ${capped.length} chunks (analysis-decided queries) for preferenceKey=${preferenceKey}`,
    );
    return capped;
  }
}
