// SearXNG HTTP API client (Direct mode)

import type { SearXNGConfig } from '@/core/config/mcp';
import { logger } from '@/utils/logger';
import type { SearchOptions, SearchResult, SearXNGSearchResponse } from './types';

export class SearXNGClient {
  private baseUrl: string;
  private authUsername?: string;
  private authPassword?: string;
  private userAgent: string;
  private proxy?: { http?: string; https?: string };

  constructor(config: SearXNGConfig) {
    this.baseUrl = config.url.replace(/\/$/, ''); // Remove trailing slash
    this.authUsername = config.authUsername;
    this.authPassword = config.authPassword;
    this.userAgent = config.userAgent || 'qqbot/1.0';
    this.proxy = config.proxy;
  }

  /**
   * Execute web search using SearXNG API
   */
  async webSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const pageno = options?.pageno || 1;
    const timeRange = options?.timeRange;
    const language = options?.language || 'all';
    const safesearch = options?.safesearch;

    // Build query parameters
    const params = new URLSearchParams({
      q: query,
      pageno: pageno.toString(),
      format: 'json',
      language,
    });

    if (timeRange) {
      params.append('time_range', timeRange);
    }

    if (safesearch !== undefined) {
      params.append('safesearch', safesearch.toString());
    }

    const url = `${this.baseUrl}/search?${params.toString()}`;

    logger.debug(`[SearXNGClient] Searching: ${query} (page ${pageno})`);

    let lastError: Error | null = null;
    const maxRetries = 3;

    // Retry logic with exponential backoff
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Build headers
        const headers: Record<string, string> = {
          'User-Agent': this.userAgent,
        };

        // Add Basic Auth if configured
        if (this.authUsername && this.authPassword) {
          const credentials = btoa(`${this.authUsername}:${this.authPassword}`);
          headers['Authorization'] = `Basic ${credentials}`;
        }

        // Set up proxy if configured
        const fetchOptions: RequestInit = {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000), // 30 second timeout
        };

        // Bun supports proxy via environment variables
        // Set proxy environment variables if configured
        const originalHttpProxy = process.env.HTTP_PROXY;
        const originalHttpsProxy = process.env.HTTPS_PROXY;

        if (this.proxy?.http) {
          process.env.HTTP_PROXY = this.proxy.http;
        }
        if (this.proxy?.https) {
          process.env.HTTPS_PROXY = this.proxy.https;
        }

        try {
          const response = await fetch(url, fetchOptions);

          // Restore original proxy settings
          if (originalHttpProxy !== undefined) {
            process.env.HTTP_PROXY = originalHttpProxy;
          } else {
            delete process.env.HTTP_PROXY;
          }
          if (originalHttpsProxy !== undefined) {
            process.env.HTTPS_PROXY = originalHttpsProxy;
          } else {
            delete process.env.HTTPS_PROXY;
          }

          if (!response.ok) {
            throw new Error(`SearXNG API error: ${response.status} ${response.statusText}`);
          }

          const data = (await response.json()) as SearXNGSearchResponse;

          // Parse and return results
          const results: SearchResult[] = (data.results || []).map((result) => ({
            title: result.title || '',
            url: result.url || '',
            snippet: result.snippet || result.content || '',
            content: result.content,
            engine: result.engine,
          }));

          logger.debug(`[SearXNGClient] Search completed: ${results.length} results`);
          return results;
        } catch (fetchError) {
          // Restore original proxy settings on error
          if (originalHttpProxy !== undefined) {
            process.env.HTTP_PROXY = originalHttpProxy;
          } else {
            delete process.env.HTTP_PROXY;
          }
          if (originalHttpsProxy !== undefined) {
            process.env.HTTPS_PROXY = originalHttpsProxy;
          } else {
            delete process.env.HTTPS_PROXY;
          }
          throw fetchError;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable (network errors, timeouts)
        const isRetryable = this.isRetryableError(lastError);

        if (attempt < maxRetries && isRetryable) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          logger.warn(
            `[SearXNGClient] Search failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
          );
          await this.delay(delay);
          continue;
        }

        // Non-retryable error or max retries reached
        logger.error(`[SearXNGClient] Search failed after ${attempt + 1} attempts:`, lastError);
        throw lastError;
      }
    }

    throw lastError || new Error('Search failed');
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const retryableMessages = ['timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
    const errorMessage = error.message.toLowerCase();
    return retryableMessages.some((msg) => errorMessage.includes(msg));
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
