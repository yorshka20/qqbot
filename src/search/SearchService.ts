// Search service - provides unified search interface

import type { PromptManager } from '@/ai/PromptManager';
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

  constructor(config?: MCPConfig) {
    this.config = config || null;
    this.maxResults = config?.search.maxResults || 8;

    if (config?.enabled && config.search.mode === 'direct') {
      this.searxngClient = new SearXNGClient(config.searxng);
      logger.info('[SearchService] Initialized in Direct mode');
    }

    // Initialize PromptManager from DI container
    const container = getContainer();
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
  }

  /**
   * Register SearXNG client with health check manager
   * Should be called after HealthCheckManager is initialized
   */
  registerHealthCheck(): void {
    if (!this.searxngClient) {
      return;
    }

    const container = getContainer();
    if (container.isRegistered(DITokens.HEALTH_CHECK_MANAGER)) {
      const healthManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
      healthManager.registerService(this.searxngClient, {
        cacheDuration: 60000, // Cache for 60 seconds
        timeout: 2000, // 2 second timeout for health checks
        retries: 0, // No retries for health checks
      });
      logger.info('[SearchService] Registered SearXNG with health check manager');
    } else {
      logger.warn('[SearchService] HealthCheckManager not available, health checks disabled');
    }
  }

  /**
   * Set MCP manager for MCP mode (will be set by MCPInitializer)
   */
  setMCPManager(mcpManager: MCPManager): void {
    this.mcpManager = mcpManager;
    logger.info('[SearchService] MCP manager set, MCP mode available');
  }

  /**
   * Execute search query
   */
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
        // Direct mode: use SearXNG HTTP API
        if (!this.searxngClient) {
          logger.warn('[SearchService] SearXNG client not initialized');
          return [];
        }

        // Fast health check before attempting search
        const container = getContainer();
        if (container.isRegistered(DITokens.HEALTH_CHECK_MANAGER)) {
          const healthManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
          const isHealthy = await healthManager.isServiceHealthy('SearXNG');
          if (!isHealthy) {
            logger.warn('[SearchService] SearXNG service is not available, skipping search');
            return [];
          }
        }

        results = await this.searxngClient.webSearch(query, {
          ...options,
          maxResults,
        });
      } else if (searchMode === 'mcp') {
        if (!this.mcpManager) {
          logger.warn('[SearchService] MCP manager not initialized, skipping search');
          return [];
        }

        const toolName = 'searxng_web_search';
        if (!this.mcpManager.hasTool(toolName)) {
          logger.warn(`[SearchService] Tool ${toolName} not found, falling back to direct mode`);
          if (this.searxngClient) {
            // Fast health check before attempting search
            const container = getContainer();
            if (container.isRegistered(DITokens.HEALTH_CHECK_MANAGER)) {
              const healthManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
              const isHealthy = await healthManager.isServiceHealthy('SearXNG');
              if (!isHealthy) {
                logger.warn('[SearchService] SearXNG service is not available, skipping search');
                return [];
              }
            }

            results = await this.searxngClient.webSearch(query, {
              ...options,
              maxResults,
            });
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

  /**
   * Format search results for LLM prompt
   */
  formatSearchResults(results: SearchResult[]): string {
    if (results.length === 0) {
      return '';
    }

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

    return this.promptManager.render('llm.format_search_results', {
      totalResults: results.length.toString(),
      formattedResults: formatted,
    });
  }

  /**
   * Format multiple search results by combining all results together
   * AI will provide unified response instead of grouped response
   */
  formatMultiSearchResults(
    searchResults: Array<{
      queryIndex: number;
      query: string;
      explanation: string;
      results: SearchResult[];
    }>,
  ): string {
    if (searchResults.length === 0) {
      return '';
    }

    // Collect all results from all queries
    const allResults: SearchResult[] = [];
    const queryInfo: string[] = [];

    searchResults.forEach((searchResult) => {
      const { query, explanation, results } = searchResult;

      // Add query information for context
      queryInfo.push(`查询: ${query} (${explanation})`);

      // Add all results from this query
      allResults.push(...results.slice(0, 5)); // Limit to 5 results per query
    });

    // Remove duplicates based on URL
    const uniqueResults = allResults.filter(
      (result, index, self) => index === self.findIndex((r) => r.url === result.url),
    );

    // Limit total results to prevent information overload
    const limitedResults = uniqueResults.slice(0, 12); // Max 12 results total

    // Format all results together (same format as single search)
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

    // Add query context information at the beginning
    const queryContext = `基于以下 ${searchResults.length} 个查询的综合搜索结果：\n${queryInfo.join('\n')}\n\n`;

    // Use the same template as single search results
    return this.promptManager.render('llm.format_search_results', {
      totalResults: limitedResults.length.toString(),
      formattedResults: queryContext + formatted,
    });
  }

  /**
   * Parse MCP search results from text format
   * MCP returns results as formatted text, we need to parse it back to structured format
   */
  private parseMCPSearchResults(resultText: string): SearchResult[] {
    // MCP searxng_web_search returns formatted text like:
    // "1. [Title](URL)\n   Snippet..."
    // We'll parse this back to structured format
    const results: SearchResult[] = [];
    const lines = resultText.split('\n');

    let currentResult: Partial<SearchResult> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Match numbered result: "1. [Title](URL)"
      const numberedMatch = trimmed.match(/^\d+\.\s*\[([^\]]+)\]\(([^)]+)\)/);
      if (numberedMatch) {
        if (currentResult?.title && currentResult?.url) {
          results.push(currentResult as SearchResult);
        }

        // Start new result
        currentResult = {
          title: numberedMatch[1],
          url: numberedMatch[2],
        };
        continue;
      }

      // Match snippet/content (indented lines)
      if (currentResult && trimmed && !trimmed.startsWith('[') && !trimmed.match(/^\d+\./)) {
        currentResult.snippet = (currentResult.snippet || '') + (currentResult.snippet ? ' ' : '') + trimmed;
      }
    }

    if (currentResult?.title && currentResult?.url) {
      results.push(currentResult as SearchResult);
    }

    return results;
  }

  /**
   * Perform smart search with AI decision making
   * This method handles the complete search workflow:
   * 1. Use LLM to determine if search is needed
   * 2. Parse search queries (single or multiple)
   * 3. Execute searches
   * 4. Format results
   */
  async performSmartSearch(userMessage: string, llmService: LLMService, sessionId?: string): Promise<string> {
    if (!this.isEnabled()) {
      return '';
    }

    try {
      // Step 1: Use LLM to determine if search is needed
      // Use search_decision template (same as recursive search) for consistency
      const checkPrompt = this.promptManager.render('llm.search_decision', {
        userMessage,
        existingInformation: 'None',
        taskResults: 'None',
        previousSearchResults: 'None',
      });

      const checkResponse = await llmService.generate(checkPrompt, {
        temperature: 0.3, // Lower temperature for more consistent judgment
        maxTokens: 150, // Allow more tokens for multi-search responses
        sessionId,
      });

      const searchDecision = this.parseSearchDecision(checkResponse.text);
      if (!searchDecision.needsSearch) {
        return '';
      }

      let searchQueries: Array<{ query: string; explanation: string }> = [];

      if (searchDecision.isMultiSearch && searchDecision.queries && searchDecision.queries.length > 0) {
        // Multiple search queries
        searchQueries = searchDecision.queries;
        logger.info(
          `[SearchService] Multi-search triggered with ${searchQueries.length} queries:`,
          searchQueries.map((q) => q.query),
        );
      } else {
        // Single search query
        const query = searchDecision.query || this.extractSearchQuery(userMessage);
        if (query) {
          searchQueries = [{ query, explanation: 'User query' }];
          logger.info(`[SearchService] Search triggered for query: ${query}`);
        }
      }

      if (searchQueries.length === 0) {
        return '';
      }

      // Step 2: Execute searches
      if (searchQueries.length === 1) {
        // Single search
        const searchResults = await this.search(searchQueries[0].query);
        return this.formatSearchResults(searchResults);
      } else {
        // Multiple searches - execute in parallel and format with grouping
        const searchPromises = searchQueries.map(async (queryInfo, index) => {
          try {
            const results = await this.search(queryInfo.query);
            return {
              queryIndex: index + 1,
              query: queryInfo.query,
              explanation: queryInfo.explanation,
              results,
            };
          } catch (error) {
            logger.warn(`[SearchService] Search failed for query "${queryInfo.query}":`, error);
            return {
              queryIndex: index + 1,
              query: queryInfo.query,
              explanation: queryInfo.explanation,
              results: [],
            };
          }
        });

        const searchResults = await Promise.all(searchPromises);
        return this.formatMultiSearchResults(searchResults);
      }
    } catch (error) {
      logger.warn('[SearchService] Smart search failed, continuing without search:', error);
      return '';
    }
  }

  /**
   * Parse LLM response to determine if search is needed
   * Expected formats:
   * - "SEARCH: <keywords>" for single search
   * - "MULTI_SEARCH:" for multiple searches
   * - "NO_SEARCH" for no search needed
   */
  private parseSearchDecision(response: string): {
    needsSearch: boolean;
    query?: string;
    queries?: Array<{ query: string; explanation: string }>;
    isMultiSearch?: boolean;
  } {
    const trimmed = response.trim();
    const upperTrimmed = trimmed.toUpperCase();

    // Check if response starts with "MULTI_SEARCH:"
    if (upperTrimmed.startsWith('MULTI_SEARCH:')) {
      const multiSearchContent = trimmed.substring(13).trim(); // Remove "MULTI_SEARCH:" prefix
      const queries = this.parseMultiSearchQueries(multiSearchContent);

      return {
        needsSearch: queries.length > 0,
        queries,
        isMultiSearch: true,
      };
    }

    // Check if response starts with "SEARCH:"
    if (upperTrimmed.startsWith('SEARCH:')) {
      const query = trimmed.substring(7).trim(); // Remove "SEARCH:" prefix, preserve original case for query
      return {
        needsSearch: true,
        query: query || undefined,
        isMultiSearch: false,
      };
    }

    // No search needed (handles "NO_SEARCH" or any other response)
    return {
      needsSearch: false,
      isMultiSearch: false,
    };
  }

  /**
   * Parse MULTI_SEARCH format into individual queries
   * Format: "查询1: <query> | <explanation>\n查询2: <query> | <explanation>"
   */
  private parseMultiSearchQueries(content: string): Array<{ query: string; explanation: string }> {
    const queries: Array<{ query: string; explanation: string }> = [];
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line);

    for (const line of lines) {
      // Match format like "查询1: search term | explanation"
      const match = line.match(/^查询\d+:\s*(.+?)\s*\|\s*(.+)$/);
      if (match) {
        const [, query, explanation] = match;
        queries.push({
          query: query.trim(),
          explanation: explanation.trim(),
        });
      } else {
        // Fallback: treat entire line as query if format doesn't match
        queries.push({
          query: line,
          explanation: '自动提取的搜索查询',
        });
      }
    }

    return queries;
  }

  /**
   * Extract search query from user message (fallback method)
   */
  private extractSearchQuery(message: string): string {
    // Simple extraction: remove common question words and use the rest as query
    const questionWords = ['什么', '怎么', '如何', '为什么', '哪里', '哪个', '谁', '何时', '搜索', '查询', '查找'];
    let query = message.trim();

    // Remove question words from the beginning
    for (const word of questionWords) {
      if (query.startsWith(word)) {
        query = query.substring(word.length).trim();
        break;
      }
    }

    return query || message; // Fallback to original message if extraction fails
  }

  /**
   * Check if search is enabled and configured
   */
  isEnabled(): boolean {
    return this.config?.enabled === true && this.config?.search.enabled === true;
  }
}
