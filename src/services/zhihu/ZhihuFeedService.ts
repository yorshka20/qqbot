// ZhihuFeedService — feed polling, deduplication, and storage

import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuFeedItemRow } from './types';
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

  /** Poll feed, parse, deduplicate, and store. Returns counts. */
  async pollFeed(): Promise<{ newCount: number; duplicateCount: number; totalFetched: number }> {
    // Check cookie first
    if (!this.client.isCookieValid()) {
      const valid = await this.client.checkCookieValidity();
      if (!valid) {
        logger.warn('[ZhihuFeedService] Cookie invalid, skipping poll');
        return { newCount: 0, duplicateCount: 0, totalFetched: 0 };
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

      return { newCount, duplicateCount, totalFetched: feedItems.length };
    } catch (err) {
      logger.error('[ZhihuFeedService] Poll failed:', err);
      return { newCount: 0, duplicateCount: 0, totalFetched: 0 };
    }
  }

  // ──────────────────────────────────────────────────
  // Content enrichment
  // ──────────────────────────────────────────────────

  /** Fetch full content for top items (by vote count). */
  async enrichTopItems(items: ZhihuFeedItemRow[], topN = 3): Promise<void> {
    // Sort by voteupCount descending, pick top N that are ANSWER_CREATE or ARTICLE_CREATE
    const enrichable = items
      .filter((i) => (i.verb === 'ANSWER_CREATE' || i.verb === 'ARTICLE_CREATE') && !i.content)
      .sort((a, b) => b.voteupCount - a.voteupCount)
      .slice(0, topN);

    for (const item of enrichable) {
      try {
        if (item.targetType === 'answer') {
          const answer = await this.client.fetchAnswerContent(item.targetId);
          if (answer.content) {
            this.db.updateContent(item.id, answer.content);
            logger.debug(`[ZhihuFeedService] Enriched answer ${item.targetId}`);
          }
        } else if (item.targetType === 'article') {
          const article = await this.client.fetchArticleContent(item.targetId);
          if (article.content) {
            this.db.updateContent(item.id, article.content);
            logger.debug(`[ZhihuFeedService] Enriched article ${item.targetId}`);
          }
        }
      } catch (err) {
        logger.warn(`[ZhihuFeedService] Failed to enrich ${item.targetType} ${item.targetId}:`, err);
      }
    }
  }

  // ──────────────────────────────────────────────────
  // Query methods
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

  getStats(): {
    totalItems: number;
    lastFetchTs: number;
    cookieValid: boolean;
    countByVerb: Array<{ verb: string; count: number }>;
  } {
    return {
      totalItems: this.db.getTotalCount(),
      lastFetchTs: this.db.getLastFetchTimestamp(),
      cookieValid: this.client.isCookieValid(),
      countByVerb: this.db.getCountByVerb(),
    };
  }

  /** Expose client for cookie updates. */
  getClient(): ZhihuClient {
    return this.client;
  }

  /** Convert a row to a content item for display. */
  static rowToDisplayItem(row: ZhihuFeedItemRow): ZhihuContentItem {
    return {
      id: row.id,
      feedId: row.feedId,
      verb: row.verb,
      targetType: row.targetType,
      targetId: row.targetId,
      title: row.title,
      excerpt: row.excerpt,
      content: row.content ?? undefined,
      url: row.url,
      authorName: row.authorName,
      authorUrlToken: row.authorUrlToken,
      authorAvatarUrl: row.authorAvatarUrl ?? undefined,
      voteupCount: row.voteupCount,
      commentCount: row.commentCount,
      actorNames: JSON.parse(row.actorNames || '[]'),
      createdTime: row.createdTime,
      fetchedAt: row.fetchedAt,
    };
  }
}
