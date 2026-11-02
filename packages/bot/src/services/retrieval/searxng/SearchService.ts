// Search service - web search via SearXNG (direct or MCP)

import { logger } from '@qqbot/shared';
import type { HealthCheckManager } from '@qqbot/shared/health';
import type { MCPConfig, SearchProvider } from '@/core/config/types/mcp';
import type { PageContentFetchService } from '../fetch';
import { SerperClient } from '../serper/SerperClient';
import { SearxngMcpClient } from './mcp/SearxngMcpClient';
import { SearXNGClient } from './SearXNGClient';
import type { SearchOptions, SearchResult } from './types';

/** The only tool this service consumes from the SearXNG MCP server. */
const SEARXNG_MCP_TOOL = 'searxng_web_search';

export interface SearchServiceOptions {
  config?: MCPConfig;
  healthCheckManager: HealthCheckManager;
  pageContentFetchService: PageContentFetchService;
}

export class SearchService {
  private searxngClient: SearXNGClient | null = null;
  private serperClient: SerperClient | null = null;
  private searxngMcpClient: SearxngMcpClient | null = null;
  private config: MCPConfig | null = null;
  private maxResults: number;
  /** Providers to try in order; only those whose client could be built. */
  private readonly providerOrder: SearchProvider[] = [];

  private healthCheckManager: HealthCheckManager;
  private pageContentFetchService: PageContentFetchService;

  constructor(options: SearchServiceOptions) {
    const { config, healthCheckManager, pageContentFetchService } = options;
    this.config = config || null;
    this.maxResults = config?.search.maxResults || 8;
    this.healthCheckManager = healthCheckManager;
    this.pageContentFetchService = pageContentFetchService;

    if (config?.enabled) {
      // Every provider in the order gets its client up front: a fallback that
      // has to be constructed at the moment the primary breaks is a fallback
      // that first fails on whatever the constructor needs.
      const configured = [config.search.provider ?? 'searxng', ...(config.search.fallbackOrder ?? [])];
      for (const name of new Set(configured)) {
        if (this.buildBackend(name, config)) {
          this.providerOrder.push(name);
        }
      }
      logger.info(
        this.providerOrder.length > 0
          ? `[SearchService] Initialized | provider order: ${this.providerOrder.join(' → ')}`
          : '[SearchService] Initialized with no usable search provider — search will fail',
      );
    }
  }

  /** Construct one provider's client. Returns false when it cannot be used at all. */
  private buildBackend(name: SearchProvider, config: MCPConfig): boolean {
    if (name === 'serper') {
      if (!config.serper?.apiKey) {
        logger.warn('[SearchService] serper is in the provider order but mcp.serper.apiKey is missing; skipping it');
        return false;
      }
      this.serperClient = new SerperClient(config.serper);
      return true;
    }

    if (config.search.mode === 'direct') {
      this.searxngClient = new SearXNGClient(config.searxng);
      return true;
    }
    if (config.server.enabled) {
      this.searxngMcpClient = new SearxngMcpClient(config);
      return true;
    }
    logger.warn(
      '[SearchService] searxng is in the provider order with mode=mcp but mcp.server.enabled is false; skipping it',
    );
    return false;
  }

  /**
   * Bring up transports that need I/O to become usable. Separate from the
   * constructor because the MCP transport spawns a child process and performs
   * a protocol handshake; the HTTP-based clients are ready on construction.
   */
  async connectTransports(): Promise<void> {
    await this.searxngMcpClient?.connect();
  }

  async disconnectTransports(): Promise<void> {
    await this.searxngMcpClient?.disconnect();
  }

  getPageContentFetchService(): PageContentFetchService {
    return this.pageContentFetchService;
  }

  /**
   * Only SearXNG is registered: its probe is a free request to a self-hosted
   * instance. Serper has no free probe — the only request that reveals an
   * exhausted key is a billed SERP call, and `/healthcheck all` would spend one
   * per invocation. Its liveness comes from the search requests themselves,
   * which fall through to the next provider on failure.
   */
  registerHealthCheck(): void {
    if (this.searxngClient) {
      this.healthCheckManager.registerService(this.searxngClient, {
        cacheDuration: 60000,
        timeout: 2000,
        retries: 0,
      });
    }
  }

  /**
   * Run one web search, walking the configured provider order.
   *
   * Throws when no provider could serve the request — disabled, no client, or
   * every provider in the order failed. An empty array therefore means one
   * thing only: a backend answered and had nothing. Callers that treat search
   * as optional enrichment catch and carry on; the LLM-facing tool needs the
   * distinction, because "every backend refused" reported as "nothing was
   * found" is a different claim, not a degraded one.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const [results] = await this.searchBatch([query], options);
    return results ?? [];
  }

  /**
   * Run several independent queries as one step, answering in the same order.
   *
   * Exists because the per-query cost is identical either way — Serper bills each
   * query in a batch exactly as if sent alone — while the per-*step* cost is not:
   * batched, N queries take one round trip, one timeout and one fallback
   * decision. So breadth is free in latency terms, and asking several angles at
   * once is strictly better than guessing which single query will land.
   */
  async searchBatch(queries: string[], options?: SearchOptions): Promise<SearchResult[][]> {
    if (!this.config?.enabled) {
      throw new Error('Search is not enabled or configured');
    }
    if (this.providerOrder.length === 0) {
      throw new Error('No search provider is usable (check mcp.search.provider / fallbackOrder and credentials)');
    }
    if (queries.length === 0) {
      return [];
    }

    const maxResults = options?.maxResults || this.maxResults;
    // Merge config defaults: language (e.g. "zh"), engines (e.g. "baidu,bing"). No default timeRange: prefer year-in-keywords for timeliness.
    const mergedOptions: SearchOptions = {
      ...options,
      maxResults,
      language: options?.language ?? this.config.search.language,
      engines: options?.engines ?? this.config.search.engines,
    };

    const skipped: string[] = [];
    for (const name of this.providerOrder) {
      try {
        const batches = await this.runProviderBatch(name, queries, mergedOptions);
        if (skipped.length > 0) {
          logger.info(`[SearchService] Served by fallback provider "${name}" after: ${skipped.join('; ')}`);
        }
        return batches.map((results) => results.slice(0, maxResults));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push(`${name}: ${reason}`);
        logger.warn(`[SearchService] Provider "${name}" could not serve the queries: ${reason}`);
      }
    }

    throw new Error(`All search providers failed — ${skipped.join('; ')}`);
  }

  /**
   * Attempt one provider for the whole batch. No pre-flight health probe: with a
   * provider order in place the request itself is the probe, and for a metered
   * backend a probe is a billed call that answers a question the next real search
   * answers for free. A provider that fails here simply yields to the next one.
   */
  private async runProviderBatch(
    name: SearchProvider,
    queries: string[],
    options: SearchOptions,
  ): Promise<SearchResult[][]> {
    if (name === 'serper') {
      const client = this.serperClient;
      if (!client) {
        throw new Error('serper client was not initialized');
      }
      return client.webSearchBatch(queries, options);
    }

    // SearXNG has no batch endpoint on either transport, so the batch is only a
    // concurrency hint there. The caller's contract is unchanged either way.
    return Promise.all(queries.map((query) => this.runSearxngQuery(query, options)));
  }

  private async runSearxngQuery(query: string, options: SearchOptions): Promise<SearchResult[]> {
    if (this.searxngClient) {
      return this.searxngClient.webSearch(query, options);
    }

    // The MCP transport advertises readiness only through its tool listing.
    if (!this.searxngMcpClient?.hasTool(SEARXNG_MCP_TOOL)) {
      throw new Error(`MCP tool ${SEARXNG_MCP_TOOL} is unavailable`);
    }
    const toolResult = await this.searxngMcpClient.callTool(SEARXNG_MCP_TOOL, {
      query,
      pageno: options.pageno ?? 1,
      ...(options.timeRange && { time_range: options.timeRange }),
      ...(options.language && { language: options.language }),
      ...(options.engines && { engines: options.engines }),
      ...(options.safesearch !== undefined && { safesearch: options.safesearch }),
    });
    return this.parseMCPSearchResults(toolResult.content[0]?.text || '');
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

  /** Whether a search can be attempted at all: switched on AND at least one provider built. */
  isEnabled(): boolean {
    return this.config?.search.enabled === true && this.providerOrder.length > 0;
  }
}
