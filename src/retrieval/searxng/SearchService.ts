// Search service - web search via SearXNG (direct or MCP)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { buildSearchResultSummaries, filterAndRefineSearchResults } from '@/ai/utils/searchResultsFilterRefine';
import type { MCPConfig } from '@/core/config/mcp';
import type { HealthCheckManager } from '@/core/health';
import type { MCPManager } from '@/mcp';
import { logger } from '@/utils/logger';
import type { FetchProgressNotifier, PageContentFetchService } from '../fetch';
import { SearXNGClient } from './SearXNGClient';
import type { SearchOptions, SearchResult } from './types';

/** Max filter-refine rounds (avoid infinite loop). */
export const FILTER_REFINE_MAX_ROUNDS = 2;
/** Max results per supplement search when filter returns MORE. */
export const FILTER_SUPPLEMENT_MAX_RESULTS = 4;

export interface SearchServiceOptions {
  config?: MCPConfig;
  promptManager: PromptManager;
  healthCheckManager: HealthCheckManager;
  pageContentFetchService: PageContentFetchService;
}

export class SearchService {
  private searxngClient: SearXNGClient | null = null;
  private mcpManager: MCPManager | null = null;
  private config: MCPConfig | null = null;
  private maxResults: number;

  private promptManager: PromptManager;
  private healthCheckManager: HealthCheckManager;
  private pageContentFetchService: PageContentFetchService;

  constructor(options: SearchServiceOptions) {
    const { config, promptManager, healthCheckManager, pageContentFetchService } = options;
    this.config = config || null;
    this.maxResults = config?.search.maxResults || 8;
    this.promptManager = promptManager;
    this.healthCheckManager = healthCheckManager;
    this.pageContentFetchService = pageContentFetchService;

    if (config?.enabled && config.search.mode === 'direct') {
      this.searxngClient = new SearXNGClient(config.searxng);
      logger.info('[SearchService] Initialized in Direct mode');
    }
  }

  getPageContentFetchService(): PageContentFetchService {
    return this.pageContentFetchService;
  }

  registerHealthCheck(): void {
    if (!this.searxngClient) {
      return;
    }
    this.healthCheckManager.registerService(this.searxngClient, {
      cacheDuration: 60000,
      timeout: 2000,
      retries: 0,
    });
  }

  setMCPManager(mcpManager: MCPManager): void {
    this.mcpManager = mcpManager;
    logger.info('[SearchService] MCP manager set, MCP mode available');
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!this.config || !this.config.enabled) {
      logger.warn('[SearchService] Search is not enabled or configured');
      return [];
    }

    const searchMode = this.config.search.mode;
    const maxResults = options?.maxResults || this.maxResults;
    // Merge config defaults: language (e.g. "zh"), engines (e.g. "baidu,bing"). No default timeRange: prefer year-in-keywords for timeliness.
    const mergedOptions: SearchOptions = {
      ...options,
      maxResults,
      language: options?.language ?? this.config.search.language,
      engines: options?.engines ?? this.config.search.engines,
    };

    try {
      let results: SearchResult[] = [];

      if (searchMode === 'direct') {
        if (!this.searxngClient) {
          logger.warn('[SearchService] SearXNG client not initialized');
          return [];
        }
        if (this.healthCheckManager && !(await this.healthCheckManager.isServiceHealthy('SearXNG'))) {
          logger.warn('[SearchService] SearXNG service is not available, skipping search');
          return [];
        }
        results = await this.searxngClient.webSearch(query, mergedOptions);
      } else if (searchMode === 'mcp') {
        if (!this.mcpManager) {
          logger.warn('[SearchService] MCP manager not initialized, skipping search');
          return [];
        }
        const toolName = 'searxng_web_search';
        if (!this.mcpManager.hasTool(toolName)) {
          logger.warn(`[SearchService] Tool ${toolName} not found, falling back to direct mode`);
          if (this.searxngClient) {
            if (this.healthCheckManager && !(await this.healthCheckManager.isServiceHealthy('SearXNG'))) {
              logger.warn('[SearchService] SearXNG service is not available, skipping search');
              return [];
            }
            results = await this.searxngClient.webSearch(query, mergedOptions);
          } else {
            logger.warn('[SearchService] MCP tool not available and SearXNG client not initialized, skipping search');
            return [];
          }
        } else {
          try {
            const toolResult = await this.mcpManager.callTool(toolName, {
              query,
              pageno: mergedOptions.pageno ?? 1,
              ...(mergedOptions.timeRange && { time_range: mergedOptions.timeRange }),
              ...(mergedOptions.language && { language: mergedOptions.language }),
              ...(mergedOptions.engines && { engines: mergedOptions.engines }),
              ...(mergedOptions.safesearch !== undefined && { safesearch: mergedOptions.safesearch }),
            });
            const resultText = toolResult.content[0]?.text || '';
            results = this.parseMCPSearchResults(resultText);
          } catch (error) {
            logger.warn(
              `[SearchService] MCP tool call failed: ${error instanceof Error ? error.message : String(error)}, skipping search`,
            );
            return [];
          }
        }
      }

      return results.slice(0, maxResults);
    } catch (error) {
      logger.warn(
        `[SearchService] Search failed: ${error instanceof Error ? error.message : String(error)}, returning empty results`,
      );
      return [];
    }
  }

  formatSearchResults(results: SearchResult[]): string {
    if (results.length === 0) return '';

    const formatted = results
      .slice(0, 8)
      .map((result, index) => {
        // Use full snippet so reference knowledge is complete (no truncation)
        const snippet = (result.snippet || result.content || '').trim();
        let domain = '';
        try {
          domain = new URL(result.url).hostname.replace('www.', '');
        } catch {
          domain = '未知来源';
        }
        return `${index + 1}. **${result.title}**\n   来源: ${domain}\n   摘要: ${snippet}\n   链接: ${result.url}`;
      })
      .join('\n\n');

    return this.promptManager.render(
      'llm.format_search_results',
      { totalResults: results.length.toString(), formattedResults: formatted },
      { injectBase: true },
    );
  }

  formatMultiSearchResults(
    searchResults: Array<{ queryIndex: number; query: string; explanation: string; results: SearchResult[] }>,
  ): string {
    if (searchResults.length === 0) return '';

    const allResults: SearchResult[] = [];
    const queryInfo: string[] = [];
    searchResults.forEach(({ query, explanation, results }) => {
      queryInfo.push(`查询: ${query} (${explanation})`);
      allResults.push(...results.slice(0, 5));
    });

    const uniqueResults = allResults.filter(
      (result, index, self) => index === self.findIndex((r) => r.url === result.url),
    );
    const limitedResults = uniqueResults.slice(0, 12);

    const formatted = limitedResults
      .map((result, index) => {
        // Use full snippet so reference knowledge is complete (no truncation)
        const snippet = (result.snippet || result.content || '').trim();
        let domain = '';
        try {
          domain = new URL(result.url).hostname.replace('www.', '');
        } catch {
          domain = '未知来源';
        }
        return `${index + 1}. **${result.title}**\n   来源: ${domain}\n   摘要: ${snippet}\n   链接: ${result.url}`;
      })
      .join('\n\n');

    const queryContext = `基于以下 ${searchResults.length} 个查询的综合搜索结果：\n${queryInfo.join('\n')}\n\n`;
    return this.promptManager.render(
      'llm.format_search_results',
      { totalResults: limitedResults.length.toString(), formattedResults: queryContext + formatted },
      { injectBase: true },
    );
  }

  private parseMCPSearchResults(resultText: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = resultText.split('\n');
    let currentResult: Partial<SearchResult> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      const numberedMatch = trimmed.match(/^\d+\.\s*\[([^\]]+)\]\(([^)]+)\)/);
      if (numberedMatch) {
        if (currentResult?.title && currentResult?.url) {
          results.push(currentResult as SearchResult);
        }
        currentResult = { title: numberedMatch[1], url: numberedMatch[2] };
        continue;
      }
      if (currentResult && trimmed && !trimmed.startsWith('[') && !trimmed.match(/^\d+\./)) {
        currentResult.snippet = (currentResult.snippet || '') + (currentResult.snippet ? ' ' : '') + trimmed;
      }
    }
    if (currentResult?.title && currentResult?.url) {
      results.push(currentResult as SearchResult);
    }
    return results;
  }

  async performSmartSearch(userMessage: string, llmService: LLMService, sessionId?: string): Promise<string> {
    const out = await this.performSmartSearchWithResults(userMessage, llmService, sessionId);
    return out.formattedText;
  }

  /**
   * Smart search + filter-refine loop. Returns refined reference text for reply prompts (no inline data logic in reply flow).
   * When filter-refine returns DONE, optionally fetches full page for top 2-3 results and appends "补充全文" section.
   */
  async performSmartSearchRefined(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
    fetchProgressNotifier?: FetchProgressNotifier,
  ): Promise<string> {
    const { formattedText, results } = await this.performSmartSearchWithResults(userMessage, llmService, sessionId);
    if (results.length === 0) {
      logger.info('[SearchService] performSmartSearchRefined: no results, skip filter-refine');
      return formattedText;
    }
    const topic = userMessage.trim() || '当前话题';
    logger.info(
      `[SearchService] performSmartSearchRefined: topic="${topic}", resultsCount=${results.length}, starting filter-refine loop`,
    );
    let currentResults = results;
    let refinedText = formattedText;
    for (let round = 1; round <= FILTER_REFINE_MAX_ROUNDS; round++) {
      logger.info(
        `[SearchService] filter-refine round ${round}/${FILTER_REFINE_MAX_ROUNDS}, currentResultsCount=${currentResults.length}`,
      );
      const resultSummaries = buildSearchResultSummaries(currentResults);
      const filterResult = await filterAndRefineSearchResults(llmService, this.promptManager, {
        topic,
        resultSummaries,
        round,
        maxRounds: FILTER_REFINE_MAX_ROUNDS,
      });
      if (filterResult.done) {
        refinedText = filterResult.refinedText || refinedText;
        logger.info(
          `[SearchService] filter-refine round ${round}: DONE, refinedText length=${refinedText.length}, full refinedText:\n${refinedText}`,
        );

        // Full-page fetch for top 2-3 results (article or video description).
        const fetchService = this.getPageContentFetchService();
        if (fetchService?.isEnabled()) {
          const toFetch = currentResults.slice(0, 5).map((r) => ({
            url: r.url,
            title: r.title || '无标题',
            snippet: (r.snippet || r.content || '').trim(),
          }));
          const fetched = await fetchService.fetchPages(toFetch, fetchProgressNotifier);
          if (fetched.length > 0) {
            const merged = fetched.map((e) => `### ${e.title}\n${e.text}`).join('\n\n');
            refinedText += `\n\n## 补充全文\n\n${merged}`;
            logger.info(
              `[SearchService] performSmartSearchRefined: appended ${fetched.length} fetched pages to refinedText`,
            );
          }
        }
        break;
      }
      logger.info(
        `[SearchService] filter-refine round ${round}: MORE, queries: ${JSON.stringify(filterResult.queries)}`,
      );
      if (round === FILTER_REFINE_MAX_ROUNDS) {
        logger.info('[SearchService] filter-refine: max rounds reached, using current refinedText');
        break;
      }
      for (const q of filterResult.queries) {
        try {
          const more = await this.search(q.trim(), { maxResults: FILTER_SUPPLEMENT_MAX_RESULTS });
          currentResults = [...currentResults, ...more];
          logger.info(
            `[SearchService] filter-refine supplement search query="${q}", got ${more.length} results, totalResults=${currentResults.length}`,
          );
        } catch {
          // ignore per-query failure
        }
      }
    }
    logger.info(`[SearchService] performSmartSearchRefined: final refinedText length=${refinedText.length}`);
    return refinedText;
  }

  /**
   * Same as performSmartSearch but returns both formatted text and raw SearchResult[] for downstream filter-refine step.
   */
  async performSmartSearchWithResults(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
  ): Promise<{ formattedText: string; results: SearchResult[] }> {
    if (!this.isEnabled()) {
      return { formattedText: '', results: [] };
    }

    try {
      const checkPrompt = this.promptManager.render('llm.search_decision', {
        userMessage,
        existingInformation: 'None',
        taskResults: 'None',
        previousSearchResults: 'None',
      });
      const checkResponse = await llmService.generate(checkPrompt, {
        temperature: 0.3,
        maxTokens: 150,
        sessionId,
      });
      const searchDecision = this.parseSearchDecision(checkResponse.text);
      if (!searchDecision.needsSearch) {
        return { formattedText: '', results: [] };
      }

      let searchQueries: Array<{ query: string; explanation: string }> = [];
      if (searchDecision.isMultiSearch && searchDecision.queries?.length) {
        searchQueries = searchDecision.queries;
        logger.info(
          `[SearchService] Multi-search triggered with ${searchQueries.length} queries:`,
          searchQueries.map((q) => q.query),
        );
      } else {
        const query = searchDecision.query || this.extractSearchQuery(userMessage);
        if (query) {
          searchQueries = [{ query, explanation: 'User query' }];
          logger.info(`[SearchService] Search triggered for query: ${query}`);
        }
      }
      if (searchQueries.length === 0) {
        return { formattedText: '', results: [] };
      }

      if (searchQueries.length === 1) {
        const results = await this.search(searchQueries[0].query);
        return {
          formattedText: this.formatSearchResults(results),
          results,
        };
      }

      const searchPromises = searchQueries.map(async (queryInfo, index) => {
        try {
          const results = await this.search(queryInfo.query);
          return { ...queryInfo, queryIndex: index + 1, results };
        } catch (error) {
          logger.warn(`[SearchService] Search failed for query "${queryInfo.query}":`, error);
          return { ...queryInfo, queryIndex: index + 1, results: [] };
        }
      });
      const searchResultsArray = await Promise.all(searchPromises);
      const allResults = searchResultsArray.flatMap((s) => s.results);
      const formattedText = this.formatMultiSearchResults(searchResultsArray);
      return { formattedText, results: allResults };
    } catch (error) {
      logger.warn('[SearchService] Smart search failed, continuing without search:', error);
      return { formattedText: '', results: [] };
    }
  }

  private parseSearchDecision(response: string): {
    needsSearch: boolean;
    query?: string;
    queries?: Array<{ query: string; explanation: string }>;
    isMultiSearch?: boolean;
  } {
    const trimmed = response.trim();
    const upperTrimmed = trimmed.toUpperCase();

    if (upperTrimmed.startsWith('MULTI_SEARCH:')) {
      const multiSearchContent = trimmed.substring(13).trim();
      const queries = this.parseMultiSearchQueries(multiSearchContent);
      return { needsSearch: queries.length > 0, queries, isMultiSearch: true };
    }
    if (upperTrimmed.startsWith('SEARCH:')) {
      const query = trimmed.substring(7).trim();
      return { needsSearch: true, query: query || undefined, isMultiSearch: false };
    }
    return { needsSearch: false, isMultiSearch: false };
  }

  private parseMultiSearchQueries(content: string): Array<{ query: string; explanation: string }> {
    const queries: Array<{ query: string; explanation: string }> = [];
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^查询\d+:\s*(.+?)\s*\|\s*(.+)$/);
      if (match) {
        queries.push({ query: match[1].trim(), explanation: match[2].trim() });
      } else {
        queries.push({ query: line, explanation: '自动提取的搜索查询' });
      }
    }
    return queries;
  }

  private extractSearchQuery(message: string): string {
    const questionWords = ['什么', '怎么', '如何', '为什么', '哪里', '哪个', '谁', '何时', '搜索', '查询', '查找'];
    let query = message.trim();
    for (const word of questionWords) {
      if (query.startsWith(word)) {
        query = query.substring(word.length).trim();
        break;
      }
    }
    return query || message;
  }

  isEnabled(): boolean {
    return this.config?.enabled === true && this.config?.search.enabled === true;
  }
}
