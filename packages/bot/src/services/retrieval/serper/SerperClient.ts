// Serper.dev HTTP API client (Google SERP proxy)

import type { SerperConfig } from '@/core/config/types/mcp';
import type { HealthCheckOptions, HealthCheckResult } from '@/core/health';
import { HealthStatus } from '@/core/health';
import type { HealthCheckable } from '@/core/health/types';
import { logger } from '@/utils/logger';
import type { SearchOptions, SearchResult } from '../searxng/types';
import type { SerperSearchResponse } from './types';

const DEFAULT_ENDPOINT = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 10000;

export class SerperClient implements HealthCheckable {
  private apiKey: string;
  private endpoint: string;
  private glOverride?: string;
  private hlOverride?: string;
  private timeoutMs: number;

  constructor(config: SerperConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint?.replace(/\/$/, '') || DEFAULT_ENDPOINT;
    this.glOverride = config.gl;
    this.hlOverride = config.hl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getServiceName(): string {
    return 'Serper';
  }

  async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const timeout = options?.timeout ?? 2000;
    const startTime = Date.now();

    if (!this.apiKey) {
      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: 0,
        message: 'Serper API key not configured',
      };
    }

    try {
      const host = new URL(this.endpoint).origin;
      const response = await fetch(host, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      });
      return {
        status: HealthStatus.HEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: `Service responded with status ${response.status}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[SerperClient] Health check failed: ${errorMessage}`);
      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: errorMessage,
      };
    }
  }

  /**
   * Execute web search via Serper.dev (Google SERP).
   * Serper is Google-only — `engines` / `categories` options are ignored.
   */
  async webSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const page = options?.pageno ?? 1;
    const num = options?.maxResults ?? 10;
    const language = options?.language;

    const hl = this.hlOverride ?? (language ? language.toLowerCase() : 'zh-cn');
    const gl = this.glOverride ?? this.deriveCountryFromLanguage(language) ?? 'cn';
    const tbs = this.mapTimeRange(options?.timeRange);

    const body: Record<string, unknown> = {
      q: query,
      gl,
      hl,
      num,
      page,
      autocorrect: true,
    };
    if (tbs) body.tbs = tbs;

    logger.debug(`[SerperClient] Searching: ${query} (gl=${gl}, hl=${hl}, num=${num}, page=${page})`);

    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Serper API error: ${response.status} ${response.statusText} ${text}`);
        }

        const data = (await response.json()) as SerperSearchResponse;
        const results = this.mapResults(data);
        const credits = data.credits;
        logger.debug(`[SerperClient] Search completed: ${results.length} results, credits used=${credits ?? '?'}`);
        return results;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = this.isRetryableError(lastError);
        if (attempt < maxRetries && isRetryable) {
          const delay = 2 ** attempt * 1000;
          logger.warn(
            `[SerperClient] Search failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
          );
          await this.delay(delay);
          continue;
        }
        logger.error(`[SerperClient] Search failed after ${attempt + 1} attempts:`, lastError);
        throw lastError;
      }
    }

    throw lastError || new Error('Serper search failed');
  }

  /** Convert Serper organic results to unified SearchResult shape. answerBox prepended when present (treated like a top result with no engine attribution). */
  private mapResults(data: SerperSearchResponse): SearchResult[] {
    const results: SearchResult[] = [];

    if (data.answerBox?.link && (data.answerBox.snippet || data.answerBox.title)) {
      results.push({
        title: data.answerBox.title || data.answerBox.snippet || '',
        url: data.answerBox.link,
        snippet: data.answerBox.snippet || '',
        engine: 'google (answerBox)',
      });
    }

    for (const item of data.organic || []) {
      if (!item.link) continue;
      results.push({
        title: item.title || '',
        url: item.link,
        snippet: item.snippet || '',
        engine: 'google',
      });
    }

    return results;
  }

  private deriveCountryFromLanguage(language?: string): string | undefined {
    if (!language) return undefined;
    const parts = language.split('-');
    if (parts.length >= 2) return parts[1].toLowerCase();
    return undefined;
  }

  private mapTimeRange(timeRange?: SearchOptions['timeRange']): string | undefined {
    if (!timeRange) return undefined;
    if (timeRange === 'day') return 'qdr:d';
    if (timeRange === 'month') return 'qdr:m';
    if (timeRange === 'year') return 'qdr:y';
    return undefined;
  }

  private isRetryableError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return false;
    if (msg.includes('401') || msg.includes('403') || msg.includes('429')) return false;
    return ['network error', 'socket hang up', 'econnreset'].some((m) => msg.includes(m));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
