// Retrieval service - unified facade for web search and vector RAG

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { MCPConfig } from '@/core/config/types/mcp';
import type { RAGConfig } from '@/core/config/types/rag';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HealthCheckManager } from '@/core/health';
import type { MCPManager } from '@/services/mcp';
import { logger } from '@/utils/logger';
import type { FetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import { PageContentFetchService } from './fetch';
import { RAGService } from './rag/RAGService';
import type { RAGDocument, RAGSearchMultiOptions, RAGSearchOptions, RAGSearchResult } from './rag/types';
import type { FilterAndRefineOptions, FilterRefineResult } from './searchFilterRefine';
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

  /**
   * Multi-round smart search + filter-refine loop + optional page fetch. Use this for reply flow (replaces in-service search logic).
   */
  async performRecursiveSearchRefined(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
    maxIterations: number = 5,
    fetchProgressNotifier?: FetchProgressNotifier,
  ): Promise<string> {
    return this.searchService.performRecursiveSearchRefined(
      userMessage,
      llmService,
      sessionId,
      maxIterations,
      fetchProgressNotifier,
    );
  }

  getPageContentFetchService(): PageContentFetchService {
    return this.searchService.getPageContentFetchService();
  }

  async performSmartSearchWithResults(
    userMessage: string,
    llmService: LLMService,
    sessionId?: string,
    maxIterations?: number,
  ): Promise<{ formattedText: string; results: SearchResult[] }> {
    return this.searchService.performSmartSearchWithResults(userMessage, llmService, sessionId, maxIterations);
  }

  isSearchEnabled(): boolean {
    return this.searchService.isEnabled();
  }

  /**
   * Filter-refine: LLM judges relevance of search/chunk summaries and returns refined text (DONE) or supplement queries (MORE).
   */
  async filterAndRefineSearchResults(
    llmService: LLMService,
    options: FilterAndRefineOptions,
  ): Promise<FilterRefineResult> {
    return this.searchService.filterAndRefineSearchResults(llmService, options);
  }

  // --- RAG (delegate to RAGService) ---

  isRAGEnabled(): boolean {
    return this.ragService?.isEnabled() ?? false;
  }

  /**
   * Get the underlying RAG service instance.
   * Returns null if RAG is not enabled.
   */
  getRAGService(): RAGService | null {
    return this.ragService;
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
   * Scroll through all points in a collection via async generator.
   */
  async *scrollAll(
    collection: string,
    options?: { limit?: number; withPayload?: boolean | { include: string[] }; filter?: Record<string, unknown> },
  ): AsyncGenerator<Array<{ id: string | number; payload: Record<string, unknown> }>> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    yield* this.ragService.scrollAll(collection, options);
  }

  /**
   * Count points in a collection, optionally with a filter.
   */
  async countPoints(collection: string, filter?: Record<string, unknown>): Promise<number> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.countPoints(collection, filter);
  }

  /**
   * List all collections in the Qdrant instance.
   */
  async listCollections(): Promise<Array<{ name: string }>> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.listCollections();
  }

  /**
   * Get collection info (point count, vector config).
   */
  async getCollectionInfo(collection: string): Promise<{ pointsCount: number; vectorSize: number; distance: string }> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.getCollectionInfo(collection);
  }

  /**
   * Delete points by payload filter from a RAG collection.
   */
  async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.deleteByFilter(collection, filter);
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
