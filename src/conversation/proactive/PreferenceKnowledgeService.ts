// PreferenceKnowledgeService - RAG retrieval for proactive reply (Phase 2)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { RetrievalService, SearchResult } from '@/services/retrieval';
import {
  buildSummariesFromStringChunks,
  FILTER_REFINE_MAX_ROUNDS,
  FILTER_SUPPLEMENT_MAX_RESULTS,
} from '@/services/retrieval';
import { extractEntriesFromChunks } from '@/services/retrieval/fetch';
import { logger } from '@/utils/logger';
import type { FetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';

export interface PreferenceKnowledgeRetrieveOptions {
  /** Max number of chunks to return. Default implementation may ignore. */
  limit?: number;
  /** Pre-decided search queries from analysis stage. When non-empty, execute these only (no LLM in retrieve).*/
  searchQueries?: string[];
  /** Optional notifier for fetch progress. */
  fetchProgressNotifier?: FetchProgressNotifier;
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
 * We do not truncate; snippet is passed through as returned by SearXNG (ellipses in text come from the search engine).
 */
function resultsToChunks(results: SearchResult[]): string[] {
  return results.map((r) => {
    const snippet = (r.snippet || r.content || '').trim();
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
    private readonly retrievalService: RetrievalService,
    private readonly llmService: LLMService,
    private readonly promptManager: PromptManager,
  ) {}

  async retrieve(
    _preferenceKey: string,
    queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    if (!this.retrievalService?.isSearchEnabled()) {
      logger.debug('[SearXNGPreferenceKnowledgeService] Search not enabled, skipping search');
      return [];
    }

    const limit = options?.limit ?? 8;

    const searchQueries = options?.searchQueries;
    if (!searchQueries || searchQueries.length === 0) {
      return [];
    }

    let chunks = await this.executeQueries(searchQueries, limit);

    if (chunks.length > 0 && this.llmService && this.promptManager) {
      const extra = await this.checkSufficiencyAndMaybeSupplement(queryOrTopic.trim() || '当前话题', chunks, limit);
      if (extra.length > 0) {
        chunks = [...chunks, ...extra];
      }
    }

    // Filter & refine: LLM judges relevance and returns refined reference or requests more queries.
    const topic = queryOrTopic.trim() || '当前话题';
    let refinedChunks: string[] = chunks;

    if (chunks.length > 0 && this.llmService) {
      let currentChunks = chunks;
      for (let round = 1; round <= FILTER_REFINE_MAX_ROUNDS; round++) {
        const resultSummaries = buildSummariesFromStringChunks(currentChunks);
        const result = await this.retrievalService.filterAndRefineSearchResults(this.llmService, {
          topic,
          resultSummaries,
          round,
          maxRounds: FILTER_REFINE_MAX_ROUNDS,
        });

        if (result.done) {
          // Fall back to currentChunks when refinedText is empty to avoid discarding retrieved data
          refinedChunks = result.refinedText ? [result.refinedText] : currentChunks;

          // Full-page fetch for top 2-3 entries (article or video description).
          const fetchService = this.retrievalService.getPageContentFetchService();
          if (fetchService.isEnabled()) {
            const entries = extractEntriesFromChunks(currentChunks);
            const toFetch = entries.slice(0, 5).map((e) => ({
              url: e.url,
              title: e.title,
              snippet: e.snippet,
            }));
            const fetched = await fetchService.fetchPages(toFetch, options?.fetchProgressNotifier);
            if (fetched.length > 0) {
              const fetchedSection = `## 补充全文\n\n${fetched.map((e) => `### ${e.title}\n${e.text}`).join('\n\n')}`;
              refinedChunks = [...refinedChunks, fetchedSection];
            }
          }
          break;
        }

        if (round === FILTER_REFINE_MAX_ROUNDS) {
          refinedChunks = currentChunks;
          break;
        }

        // Run supplement queries and append to current chunks.
        const perQueryLimit = Math.max(2, Math.ceil(FILTER_SUPPLEMENT_MAX_RESULTS / result.queries.length));
        for (const q of result.queries) {
          try {
            const results = await this.retrievalService.search(q.trim(), {
              maxResults: perQueryLimit,
            });
            currentChunks = [...currentChunks, ...resultsToChunks(results)];
          } catch (err) {
            logger.warn(
              `[SearXNGPreferenceKnowledgeService] filter-refine supplement search failed for "${q}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    const capped = refinedChunks.slice(0, limit);
    return capped;
  }

  /**
   * Short LLM check: is retrieved knowledge sufficient? If not, return chunks from one supplement search.
   */
  private async checkSufficiencyAndMaybeSupplement(topic: string, chunks: string[], limit: number): Promise<string[]> {
    const chunksSummary = chunks.map((c, i) => `${i + 1}. ${c.replace(/\n/g, ' ').trim()}`).join('\n');

    const prompt = this.promptManager.render('llm.proactive_knowledge_sufficient', {
      topic,
      chunksSummary,
    });

    let responseText: string;
    try {
      const response = await this.llmService.generate(prompt, {
        temperature: 0.2,
        maxTokens: 1500,
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

    const room = Math.max(0, limit - chunks.length);
    const perQueryLimit = Math.max(2, Math.ceil(room / supplementQueries.length));
    const extraChunks: string[] = [];
    for (const q of supplementQueries) {
      try {
        const results = await this.retrievalService.search(q, { maxResults: perQueryLimit });
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
  private async executeQueries(queries: string[], limit: number): Promise<string[]> {
    const allChunks: string[] = [];
    const perQueryLimit = Math.max(2, Math.ceil(limit / queries.length));
    for (const query of queries) {
      try {
        const results = await this.retrievalService.search(query.trim(), { maxResults: perQueryLimit });
        allChunks.push(...resultsToChunks(results));
      } catch (err) {
        logger.warn(
          `[SearXNGPreferenceKnowledgeService] Search failed for query "${query.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return allChunks;
  }
}
