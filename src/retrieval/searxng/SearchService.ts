// Search service - web search via SearXNG (direct or MCP)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { MCPConfig } from '@/core/config/mcp';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HealthCheckManager } from '@/core/health';
import type { MCPManager } from '@/mcp';
import { logger } from '@/utils/logger';
import { SearXNGClient } from './SearXNGClient';
import type { SearchOptions, SearchResult } from './types';

export class SearchService {
  private searxngClient: SearXNGClient | null = null;
  private mcpManager: MCPManager | null = null;
  private config: MCPConfig | null = null;
  private maxResults: number;

  private promptManager: PromptManager;
  private healthCheckManager: HealthCheckManager;

  constructor(config?: MCPConfig) {
    this.config = config || null;
    this.maxResults = config?.search.maxResults || 8;

    if (config?.enabled && config.search.mode === 'direct') {
      this.searxngClient = new SearXNGClient(config.searxng);
      logger.info('[SearchService] Initialized in Direct mode');
    }

    const container = getContainer();
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.healthCheckManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
  }

  registerHealthCheck(): void {
    if (!this.searxngClient) return;

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

    try {
      let results: SearchResult[] = [];

      if (searchMode === 'direct') {
        if (!this.searxngClient) {
          logger.warn('[SearchService] SearXNG client not initialized');
          return [];
        }
        if (!(await this.healthCheckManager.isServiceHealthy('SearXNG'))) {
          logger.warn('[SearchService] SearXNG service is not available, skipping search');
          return [];
        }
        results = await this.searxngClient.webSearch(query, { ...options, maxResults });
      } else if (searchMode === 'mcp') {
        if (!this.mcpManager) {
          logger.warn('[SearchService] MCP manager not initialized, skipping search');
          return [];
        }
        const toolName = 'searxng_web_search';
        if (!this.mcpManager.hasTool(toolName)) {
          logger.warn(`[SearchService] Tool ${toolName} not found, falling back to direct mode`);
          if (this.searxngClient) {
            if (!(await this.healthCheckManager.isServiceHealthy('SearXNG'))) {
              logger.warn('[SearchService] SearXNG service is not available, skipping search');
              return [];
            }
            results = await this.searxngClient.webSearch(query, { ...options, maxResults });
          } else {
            logger.warn('[SearchService] MCP tool not available and SearXNG client not initialized, skipping search');
            return [];
          }
        } else {
          try {
            const toolResult = await this.mcpManager.callTool(toolName, {
              query,
              pageno: options?.pageno || 1,
              ...(options?.timeRange && { time_range: options.timeRange }),
              ...(options?.language && { language: options.language }),
              ...(options?.safesearch !== undefined && { safesearch: options.safesearch }),
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
        const snippet = (result.snippet || result.content || '').substring(0, 300);
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
        const snippet = (result.snippet || result.content || '').substring(0, 300);
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
    if (!this.isEnabled()) return '';

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
      if (!searchDecision.needsSearch) return '';

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
      if (searchQueries.length === 0) return '';

      if (searchQueries.length === 1) {
        const searchResults = await this.search(searchQueries[0].query);
        return this.formatSearchResults(searchResults);
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
      const searchResults = await Promise.all(searchPromises);
      return this.formatMultiSearchResults(searchResults);
    } catch (error) {
      logger.warn('[SearchService] Smart search failed, continuing without search:', error);
      return '';
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
