// Retrieval service - unified facade for web search and vector RAG

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { MCPConfig } from '@/core/config/mcp';
import type { RAGConfig } from '@/core/config/rag';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HealthCheckManager } from '@/core/health';
import type { MCPManager } from '@/mcp';
import { logger } from '@/utils/logger';
import type { FetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import { PageContentFetchService } from './fetch';
import { RAGService } from './rag/RAGService';
import type { RAGDocument, RAGSearchMultiOptions, RAGSearchOptions, RAGSearchResult } from './rag/types';
import { SearchService } from './searxng/SearchService';
import type { SearchOptions, SearchResult } from './searxng/types';

export class RetrievalService {
  private searchService: SearchService;
  private ragService: RAGService | null = null;
  private readonly pageContentFetchService: PageContentFetchService;

  constructor(
    mcpConfig: MCPConfig | undefined,
    ragConfig: RAGConfig | undefined,
    healthCheckManager: HealthCheckManager,
  ) {
    const promptManager = getContainer().resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.pageContentFetchService = new PageContentFetchService({
      config: mcpConfig?.search?.fetch ?? undefined,
    });
    this.searchService = new SearchService({
      config: mcpConfig,
      promptManager,
      healthCheckManager,
      pageContentFetchService: this.pageContentFetchService,
    });

    if (ragConfig?.enabled) {
      this.ragService = new RAGService(ragConfig);
      logger.info('[RetrievalService] Initialized with search + RAG');
    } else {
      logger.info('[RetrievalService] Initialized with search only');
    }
  }

  registerHealthCheck(): void {
    this.searchService.registerHealthCheck();
  }

  setMCPManager(mcpManager: MCPManager): void {
    this.searchService.setMCPManager(mcpManager);
  }

  // --- Search (delegate to SearchService) ---

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.searchService.search(query, options);
  }

  formatSearchResults(results: SearchResult[]): string {
    return this.searchService.formatSearchResults(results);
  }

  formatMultiSearchResults(
    searchResults: Array<{ queryIndex: number; query: string; explanation: string; results: SearchResult[] }>,
  ): string {
    return this.searchService.formatMultiSearchResults(searchResults);
  }

  async performSmartSearch(userMessage: string, llmService: LLMService, sessionId?: string): Promise<string> {
    return this.searchService.performSmartSearch(userMessage, llmService, sessionId);
  }

  /** Smart search + filter-refine; returns refined text for reply. Prefer this over performSmartSearch in reply flow. */
  async performSmartSearchRefined(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
    fetchProgressNotifier?: FetchProgressNotifier,
  ): Promise<string> {
    return this.searchService.performSmartSearchRefined(userMessage, llmService, sessionId, fetchProgressNotifier);
  }

  getPageContentFetchService(): PageContentFetchService {
    return this.searchService.getPageContentFetchService();
  }

  async performSmartSearchWithResults(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
  ): Promise<{ formattedText: string; results: SearchResult[] }> {
    return this.searchService.performSmartSearchWithResults(userMessage, llmService, sessionId);
  }

  isSearchEnabled(): boolean {
    return this.searchService.isEnabled();
  }

  // --- RAG (delegate to RAGService) ---

  isRAGEnabled(): boolean {
    return this.ragService?.isEnabled() ?? false;
  }

  async upsertDocuments(collection: string, documents: RAGDocument[]): Promise<void> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.upsertDocuments(collection, documents);
  }

  async vectorSearch(collection: string, query: string, options?: RAGSearchOptions): Promise<RAGSearchResult[]> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.vectorSearch(collection, query, options);
  }

  /**
   * Multi-query vector search: pass multiple queries; RAG runs each search, merges by id (best score), returns up to maxTotal.
   */
  async vectorSearchMulti(
    collection: string,
    queries: string[],
    options?: RAGSearchMultiOptions,
  ): Promise<RAGSearchResult[]> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.vectorSearchMulti(collection, queries, options);
  }
}
