// Search service - provides unified search interface

import type { PromptManager } from '@/ai/PromptManager';
import type { MCPConfig } from '@/core/config/mcp';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
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

    // Initialize SearXNG client if in direct mode or MCP mode not enabled
    if (config && config.enabled && config.search.mode === 'direct') {
      this.searxngClient = new SearXNGClient(config.searxng);
      logger.info('[SearchService] Initialized in Direct mode');
    }

    // Initialize PromptManager from DI container
    const container = getContainer();
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
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
          throw new Error('SearXNG client not initialized');
        }

        results = await this.searxngClient.webSearch(query, {
          ...options,
          maxResults,
        });
      } else if (searchMode === 'mcp') {
        // MCP mode: use MCP server
        if (!this.mcpManager) {
          throw new Error('MCP manager not initialized');
        }

        // Check if searxng_web_search tool is available
        const toolName = 'searxng_web_search';
        if (!this.mcpManager.hasTool(toolName)) {
          logger.warn(`[SearchService] Tool ${toolName} not found, falling back to direct mode`);
          if (this.searxngClient) {
            results = await this.searxngClient.webSearch(query, {
              ...options,
              maxResults,
            });
          } else {
            throw new Error('MCP tool not available and SearXNG client not initialized');
          }
        } else {
          // Call MCP tool
          const toolResult = await this.mcpManager.callTool(toolName, {
            query,
            pageno: options?.pageno || 1,
            ...(options?.timeRange && { time_range: options.timeRange }),
            ...(options?.language && { language: options.language }),
            ...(options?.safesearch !== undefined && { safesearch: options.safesearch }),
          });

          // Parse MCP tool result (returns text format, need to parse)
          const resultText = toolResult.content[0]?.text || '';
          results = this.parseMCPSearchResults(resultText);
        }
      }

      // Limit results to maxResults
      return results.slice(0, maxResults);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[SearchService] Search failed: ${err.message}`);
      throw err;
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
        } catch (error) {
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
        // Save previous result if exists
        if (currentResult && currentResult.title && currentResult.url) {
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

    // Save last result
    if (currentResult && currentResult.title && currentResult.url) {
      results.push(currentResult as SearchResult);
    }

    return results;
  }

  /**
   * Check if search is enabled and configured
   */
  isEnabled(): boolean {
    return this.config?.enabled === true && this.config?.search.enabled === true;
  }
}
