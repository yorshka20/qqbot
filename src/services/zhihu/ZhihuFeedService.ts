// ZhihuFeedService — feed polling, deduplication, storage, and content fetching

import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuContentRecord, ZhihuContentRow, ZhihuFeedItemRow } from './types';
import { ZhihuClient } from './ZhihuClient';
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

      // Collect unique targetIds that need content fetching
      const contentCount = await this.fetchContentForItems(parsed);

      logger.info(
        `[ZhihuFeedService] Poll complete: ${feedItems.length} raw → ${parsed.length} parsed → ${newCount} new, ${duplicateCount} duplicates, ${contentCount} content fetched`,
      );

      return { newCount, duplicateCount, totalFetched: feedItems.length, contentCount };
    } catch (err) {
      logger.error('[ZhihuFeedService] Poll failed:', err);
      return { newCount: 0, duplicateCount: 0, totalFetched: 0, contentCount: 0 };
    }
  }

  // ──────────────────────────────────────────────────
  // Content fetching (runs during poll)
  // ──────────────────────────────────────────────────

  /** Fetch full content for all articles/answers in the parsed items that we don't already have. */
  private async fetchContentForItems(items: ZhihuContentItem[]): Promise<number> {
    // Collect unique (targetType, targetId) pairs for content-bearing types
    const contentTargets = new Map<string, ZhihuContentItem>();
    for (const item of items) {
      if (item.targetType === 'answer' || item.targetType === 'article') {
        const key = `${item.targetType}:${item.targetId}`;
        if (!contentTargets.has(key)) {
          contentTargets.set(key, item);
        }
      }
    }

    if (contentTargets.size === 0) return 0;

    // Check which ones we already have
    const answerIds = [...contentTargets.values()]
      .filter((i) => i.targetType === 'answer')
      .map((i) => i.targetId);
    const articleIds = [...contentTargets.values()]
      .filter((i) => i.targetType === 'article')
      .map((i) => i.targetId);

    const existingAnswers = this.db.getExistingContentIds('answer', answerIds);
    const existingArticles = this.db.getExistingContentIds('article', articleIds);

    let fetched = 0;
    for (const item of contentTargets.values()) {
      const existing = item.targetType === 'answer' ? existingAnswers : existingArticles;
      if (existing.has(item.targetId)) continue;

      try {
        const record = await this.fetchAndFormatContent(item);
        if (record) {
          this.db.upsertContent(record);
          fetched++;
        }
      } catch (err) {
        logger.warn(`[ZhihuFeedService] Failed to fetch content for ${item.targetType} ${item.targetId}:`, err);
      }
    }

    return fetched;
  }

  /** Fetch full content for a single article/answer and format it. */
  private async fetchAndFormatContent(item: ZhihuContentItem): Promise<ZhihuContentRecord | null> {
    if (item.targetType === 'answer') {
      const answer = await this.client.fetchAnswerContent(item.targetId);
      if (!answer?.content) return null;
      return {
        targetType: 'answer',
        targetId: item.targetId,
        title: answer.question?.title ?? item.title,
        url: item.url,
        authorName: answer.author?.name ?? item.authorName,
        authorUrlToken: answer.author?.url_token ?? item.authorUrlToken,
        authorAvatarUrl: answer.author?.avatar_url ?? item.authorAvatarUrl,
        content: ZhihuClient.formatContent(answer.content),
        excerpt: item.excerpt,
        voteupCount: answer.voteup_count ?? item.voteupCount,
        commentCount: answer.comment_count ?? item.commentCount,
        questionId: answer.question?.id,
        questionTitle: answer.question?.title,
        createdTime: answer.created_time ?? item.createdTime,
        fetchedAt: new Date().toISOString(),
      };
    }

    if (item.targetType === 'article') {
      const article = await this.client.fetchArticleContent(item.targetId);
      if (!article?.content) return null;
      return {
        targetType: 'article',
        targetId: item.targetId,
        title: article.title ?? item.title,
        url: item.url,
        authorName: article.author?.name ?? item.authorName,
        authorUrlToken: article.author?.url_token ?? item.authorUrlToken,
        authorAvatarUrl: article.author?.avatar_url ?? item.authorAvatarUrl,
        content: ZhihuClient.formatContent(article.content),
        excerpt: item.excerpt,
        voteupCount: article.voteup_count ?? item.voteupCount,
        commentCount: article.comment_count ?? item.commentCount,
        createdTime: article.created ?? item.createdTime,
        fetchedAt: new Date().toISOString(),
      };
    }

    return null;
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
  // Query methods — contents
  // ──────────────────────────────────────────────────

  getContent(targetType: string, targetId: number): ZhihuContentRow | null {
    return this.db.getContent(targetType, targetId);
  }

  getRecentContents(limit = 20, targetType?: string): ZhihuContentRow[] {
    return this.db.getRecentContents(limit, targetType);
  }

  searchContents(keyword: string, limit = 50): ZhihuContentRow[] {
    return this.db.searchContents(keyword, limit);
  }

  getContentsSince(sinceTs: number, limit = 500, targetType?: string): ZhihuContentRow[] {
    return this.db.getContentsSince(sinceTs, limit, targetType);
  }

  // ──────────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────────

  getStats(): {
    totalItems: number;
    lastFetchTs: number;
    cookieValid: boolean;
    countByVerb: Array<{ verb: string; count: number }>;
    contentStats: Array<{ targetType: string; count: number }>;
  } {
    return {
      totalItems: this.db.getTotalCount(),
      lastFetchTs: this.db.getLastFetchTimestamp(),
      cookieValid: this.client.isCookieValid(),
      countByVerb: this.db.getCountByVerb(),
      contentStats: this.db.getContentStats(),
    };
  }

  /** Expose client for cookie updates. */
  getClient(): ZhihuClient {
    return this.client;
  }
}
