// Retrieval service - unified facade for web search and vector RAG

import { logger } from '@qqbot/shared';
import { HealthCheckManager } from '@qqbot/shared/health';
import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import type { MCPConfig } from '@/core/config/types/mcp';
import type { RAGConfig } from '@/core/config/types/rag';
import { DITokens } from '@/core/DITokens';
import { PageContentFetchService } from './fetch';
import { RAGService } from './rag/RAGService';
import type { RAGDocument, RAGSearchMultiOptions, RAGSearchOptions, RAGSearchResult } from './rag/types';
import { SearchService } from './searxng/SearchService';
import type { SearchOptions, SearchResult } from './searxng/types';

@singleton()
export class RetrievalService {
  private searchService: SearchService;
  private ragService: RAGService | null = null;
  private readonly pageContentFetchService: PageContentFetchService;

  constructor(
    @inject(DITokens.CONFIG) config: Config,
    @inject(HealthCheckManager) healthCheckManager: HealthCheckManager,
  ) {
    const mcpConfig: MCPConfig | undefined = config.getMCPConfig();
    const ragConfig: RAGConfig | undefined = config.getRAGConfig();
    this.pageContentFetchService = new PageContentFetchService({
      config: mcpConfig?.search?.fetch ?? undefined,
    });
    this.searchService = new SearchService({
      config: mcpConfig,
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

  /**
   * Connect search transports that need I/O (currently the SearXNG MCP stdio
   * child). Call once after the DI graph is up; the constructor only builds
   * clients that are usable without a handshake.
   */
  async connectSearchTransports(): Promise<void> {
    await this.searchService.connectTransports();
  }

  async disconnectSearchTransports(): Promise<void> {
    await this.searchService.disconnectTransports();
  }

  // --- Search (delegate to SearchService) ---

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.searchService.search(query, options);
  }

  /** Several independent queries as one step; results come back in query order. */
  async searchBatch(queries: string[], options?: SearchOptions): Promise<SearchResult[][]> {
    return this.searchService.searchBatch(queries, options);
  }

  getPageContentFetchService(): PageContentFetchService {
    return this.searchService.getPageContentFetchService();
  }

  isSearchEnabled(): boolean {
    return this.searchService.isEnabled();
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
   * Set (merge) payload fields on existing points without re-embedding.
   */
  async setPayload(
    collection: string,
    pointIds: Array<string | number>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ragService) throw new Error('RAG is not enabled');
    return this.ragService.setPayload(collection, pointIds, payload);
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
