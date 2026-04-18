// ZhihuFeedService — feed polling, deduplication, storage, and content fetching

import { logger } from '@/utils/logger';
import type { ZhihuFeedItemRow } from './types';
import type { ZhihuClient } from './ZhihuClient';
import type { ZhihuContentParser } from './ZhihuContentParser';
import type { ZhihuDatabase } from './ZhihuDatabase';

export interface ZhihuFeedServiceConfig {
  maxPagesPerPoll?: number;
}

export class ZhihuFeedService {
  private maxPagesPerPoll: number;

  constructor(
    private client: ZhihuClient,
    private parser: ZhihuContentParser,
    private db: ZhihuDatabase,
    config?: ZhihuFeedServiceConfig,
  ) {
    this.maxPagesPerPoll = config?.maxPagesPerPoll ?? 5;
    logger.info('[ZhihuFeedService] Initialized');
  }

  // ──────────────────────────────────────────────────
  // Core poll
  // ──────────────────────────────────────────────────

  /** Poll feed, parse, deduplicate, store, and fetch content for articles/answers. */
  async pollFeed(): Promise<{ newCount: number; duplicateCount: number; totalFetched: number; contentCount: number }> {
    // Check cookie first
    if (!this.client.isCookieValid()) {
      const valid = await this.client.checkCookieValidity();
      if (!valid) {
        logger.warn('[ZhihuFeedService] Cookie invalid, skipping poll');
        return { newCount: 0, duplicateCount: 0, totalFetched: 0, contentCount: 0 };
      }
    }

    const sinceTs = this.db.getLastFetchTimestamp();
    logger.info(
      `[ZhihuFeedService] Polling feed since ${sinceTs ? new Date(sinceTs * 1000).toISOString() : 'beginning'}`,
    );

    try {
      const feedItems = await this.client.fetchAllMomentsSince(sinceTs, this.maxPagesPerPoll);
      const parsed = this.parser.parseAll(feedItems);
      const newCount = this.db.insertItems(parsed);
      const duplicateCount = parsed.length - newCount;

      logger.info(
        `[ZhihuFeedService] Poll complete: ${feedItems.length} raw → ${parsed.length} parsed → ${newCount} new, ${duplicateCount} duplicates`,
      );

      return { newCount, duplicateCount, totalFetched: feedItems.length, contentCount: 0 };
    } catch (err) {
      logger.error('[ZhihuFeedService] Poll failed:', { message: err instanceof Error ? err.message : err });
      return { newCount: 0, duplicateCount: 0, totalFetched: 0, contentCount: 0 };
    }
  }

  // ──────────────────────────────────────────────────
  // Query methods — feed items
  // ──────────────────────────────────────────────────

  getRecentItems(limit = 20, verb?: string): ZhihuFeedItemRow[] {
    return this.db.getRecentItems(limit, verb);
  }

  getUndigestedSince(sinceTs: number, limit = 500): ZhihuFeedItemRow[] {
    return this.db.getUndigestedSince(sinceTs, limit);
  }

  getItemsSince(sinceTs: number, limit = 500): ZhihuFeedItemRow[] {
    return this.db.getItemsSince(sinceTs, limit);
  }

  markDigested(itemIds: string[]): number {
    return this.db.markDigested(itemIds);
  }

  // ──────────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────────

  getStats(): {
    totalItems: number;
    lastFetchTs: number;
    cookieValid: boolean;
    countByVerb: Array<{ verb: string; count: number }>;
    feedStatsByType: Array<{ targetType: string; count: number }>;
  } {
    return {
      totalItems: this.db.getTotalCount(),
      lastFetchTs: this.db.getLastFetchTimestamp(),
      cookieValid: this.client.isCookieValid(),
      countByVerb: this.db.getCountByVerb(),
      feedStatsByType: this.db.getFeedStatsByType(),
    };
  }

  /** Expose client for cookie updates. */
  getClient(): ZhihuClient {
    return this.client;
  }
}
