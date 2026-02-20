// PreferenceKnowledgeService - RAG retrieval for proactive reply (Phase 2)

import type { SearchService } from '@/search';
import { logger } from '@/utils/logger';

export interface PreferenceKnowledgeRetrieveOptions {
  /** Max number of chunks to return. Default implementation may ignore. */
  limit?: number;
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
 * SearXNG-based implementation: uses SearchService to run at least one web search with queryOrTopic,
 * and returns search results as supplementary knowledge chunks for the main LLM prompt.
 */
export class SearXNGPreferenceKnowledgeService implements PreferenceKnowledgeService {
  constructor(private readonly searchService: SearchService) {}

  async retrieve(
    preferenceKey: string,
    queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    const trimmed = queryOrTopic?.trim();
    if (!trimmed) {
      return [];
    }

    if (!this.searchService.isEnabled()) {
      logger.debug('[SearXNGPreferenceKnowledgeService] SearchService not enabled, skipping search');
      return [];
    }

    const limit = options?.limit ?? 8;
    try {
      const results = await this.searchService.search(trimmed, { maxResults: limit });
      if (results.length === 0) {
        return [];
      }
      const chunks = results.map((r) => {
        const snippet = (r.snippet || r.content || '').trim().substring(0, 400);
        return `**${r.title || '无标题'}**\n${snippet ? `摘要: ${snippet}\n` : ''}链接: ${r.url || ''}`.trim();
      });
      logger.debug(
        `[SearXNGPreferenceKnowledgeService] Retrieved ${chunks.length} chunks for preferenceKey=${preferenceKey} query="${trimmed.slice(0, 50)}..."`,
      );
      return chunks;
    } catch (err) {
      logger.warn(
        `[SearXNGPreferenceKnowledgeService] Search failed for query="${trimmed.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
