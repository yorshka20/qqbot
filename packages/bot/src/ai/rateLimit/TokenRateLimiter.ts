// Token rate limiter — sliding-window TPM (tokens per minute) enforcement.
//
// Prevents exceeding provider rate limits by tracking token consumption
// per provider over a rolling 60-second window and delaying requests
// when the budget is exhausted.

import { logger } from '@/utils/logger';

/** A single token consumption record. */
interface TokenRecord {
  timestamp: number;
  tokens: number;
}

/** Per-provider rate limit configuration. */
export interface ProviderRateLimitConfig {
  /** Maximum tokens per minute (input + output combined). 0 = unlimited. */
  tokensPerMinute: number;
}

/** Overall rate limiter configuration. */
export interface TokenRateLimiterConfig {
  /** Default TPM limit for providers without explicit config. 0 = unlimited. */
  defaultTokensPerMinute: number;
  /** Per-provider overrides keyed by provider name. */
  providers?: Record<string, ProviderRateLimitConfig>;
}

const WINDOW_MS = 60_000; // 60-second sliding window
const POLL_INTERVAL_MS = 500; // poll interval when waiting for capacity
const MAX_WAIT_MS = 30_000; // maximum wait time before giving up

/**
 * Sliding-window token rate limiter.
 *
 * Tracks per-provider token usage over a rolling 60-second window.
 * Before making an API call, callers invoke `waitForCapacity()` which
 * will resolve immediately if budget is available, or delay until
 * enough old records expire to free up capacity.
 */
export class TokenRateLimiter {
  /** Per-provider token usage history. */
  private usage = new Map<string, TokenRecord[]>();
  private config: TokenRateLimiterConfig;

  constructor(config?: Partial<TokenRateLimiterConfig>) {
    this.config = {
      defaultTokensPerMinute: config?.defaultTokensPerMinute ?? 0,
      providers: config?.providers,
    };

    if (this.config.defaultTokensPerMinute > 0) {
      logger.info(`[TokenRateLimiter] Initialized with default TPM=${this.config.defaultTokensPerMinute}`);
    }
  }

  /**
   * Get the TPM limit for a provider. Returns 0 for unlimited.
   */
  private getLimit(providerName: string): number {
    return this.config.providers?.[providerName]?.tokensPerMinute ?? this.config.defaultTokensPerMinute;
  }

  /**
   * Purge expired records outside the sliding window.
   */
  private purge(providerName: string): void {
    const records = this.usage.get(providerName);
    if (!records) return;

    const cutoff = Date.now() - WINDOW_MS;
    // Find first record within window (records are chronological)
    let firstValid = 0;
    while (firstValid < records.length && records[firstValid].timestamp < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      records.splice(0, firstValid);
    }
  }

  /**
   * Get current token consumption within the sliding window.
   */
  private getCurrentUsage(providerName: string): number {
    this.purge(providerName);
    const records = this.usage.get(providerName);
    if (!records || records.length === 0) return 0;
    return records.reduce((sum, r) => sum + r.tokens, 0);
  }

  /**
   * Calculate how long to wait until enough capacity is freed.
   * Returns 0 if enough capacity is available now.
   */
  private getWaitTime(providerName: string, requiredTokens: number): number {
    const limit = this.getLimit(providerName);
    if (limit <= 0) return 0; // unlimited

    this.purge(providerName);
    const records = this.usage.get(providerName);
    if (!records || records.length === 0) return 0;

    const currentUsage = records.reduce((sum, r) => sum + r.tokens, 0);
    const available = limit - currentUsage;
    if (available >= requiredTokens) return 0;

    // Need to wait until oldest records expire to free capacity.
    // Walk through records chronologically, accumulating freed tokens
    // until we have enough.
    const now = Date.now();
    let freed = available;
    for (const record of records) {
      const expiresAt = record.timestamp + WINDOW_MS;
      if (expiresAt > now) {
        freed += record.tokens;
        if (freed >= requiredTokens) {
          return expiresAt - now;
        }
      }
    }

    // Even freeing all records isn't enough (requiredTokens > limit).
    // Wait for the entire window to clear.
    return records.length > 0 ? records[records.length - 1].timestamp + WINDOW_MS - now : 0;
  }

  /**
   * Wait until the provider has enough token capacity.
   *
   * @param estimatedTokens - Estimated tokens for the upcoming request.
   *   Use a conservative estimate (e.g. current prompt size).
   * @param providerName - Provider to check.
   * @returns Actual wait time in ms (0 if no wait was needed).
   */
  async waitForCapacity(estimatedTokens: number, providerName: string): Promise<number> {
    const limit = this.getLimit(providerName);
    if (limit <= 0) return 0;

    const startTime = Date.now();
    let waited = 0;

    while (true) {
      const waitTime = this.getWaitTime(providerName, estimatedTokens);
      if (waitTime <= 0) break;

      if (waited + waitTime > MAX_WAIT_MS) {
        logger.warn(
          `[TokenRateLimiter] ${providerName}: max wait time exceeded ` +
            `(${waited}ms waited, need ${waitTime}ms more). Proceeding anyway.`,
        );
        break;
      }

      const actualWait = Math.min(waitTime, POLL_INTERVAL_MS);
      logger.debug(
        `[TokenRateLimiter] ${providerName}: rate limit approaching ` +
          `(${this.getCurrentUsage(providerName)}/${limit} TPM), ` +
          `waiting ${actualWait}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, actualWait));
      waited = Date.now() - startTime;
    }

    if (waited > 0) {
      logger.info(`[TokenRateLimiter] ${providerName}: waited ${waited}ms for rate limit capacity`);
    }

    return waited;
  }

  /**
   * Record actual token usage after a completed API call.
   *
   * @param tokens - Actual tokens consumed (input + output).
   * @param providerName - Provider that was used.
   */
  recordUsage(tokens: number, providerName: string): void {
    if (tokens <= 0) return;

    let records = this.usage.get(providerName);
    if (!records) {
      records = [];
      this.usage.set(providerName, records);
    }

    records.push({ timestamp: Date.now(), tokens });

    const limit = this.getLimit(providerName);
    if (limit > 0) {
      const currentUsage = this.getCurrentUsage(providerName);
      logger.debug(`[TokenRateLimiter] ${providerName}: recorded ${tokens} tokens ` + `(${currentUsage}/${limit} TPM)`);
    }
  }

  /**
   * Get current usage stats for a provider (for monitoring/debugging).
   */
  getStats(providerName: string): { currentUsage: number; limit: number; utilizationPct: number } {
    const limit = this.getLimit(providerName);
    const currentUsage = this.getCurrentUsage(providerName);
    return {
      currentUsage,
      limit,
      utilizationPct: limit > 0 ? Math.round((currentUsage / limit) * 100) : 0,
    };
  }
}
