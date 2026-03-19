// ZhihuFeedService — feed polling, deduplication, storage, and content fetching

import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuContentRecord, ZhihuContentRow, ZhihuFeedItemRow } from './types';
import { ZhihuClient } from './ZhihuClient';
import type { ZhihuContentParser } from './ZhihuContentParser';
import type { ZhihuDatabase } from './ZhihuDatabase';

export interface ZhihuFeedServiceConfig {
  maxPagesPerPoll?: number;
  /** Called when all content-fetch strategies fail for an item. */
  onContentFetchFailed?: (item: ZhihuContentItem, reason: string) => void;
}

export class ZhihuFeedService {
  private maxPagesPerPoll: number;
  private onContentFetchFailed?: (item: ZhihuContentItem, reason: string) => void;

  constructor(
    private client: ZhihuClient,
    private parser: ZhihuContentParser,
    private db: ZhihuDatabase,
    config?: ZhihuFeedServiceConfig,
  ) {
    this.maxPagesPerPoll = config?.maxPagesPerPoll ?? 5;
    this.onContentFetchFailed = config?.onContentFetchFailed;
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

      // Fetch content for newly parsed items
      const contentCount = await this.fetchContentForItems(parsed);

      // Backfill content for existing feed items that are missing content
      const backfillCount = await this.backfillMissingContent();

      const totalContent = contentCount + backfillCount;
      logger.info(
        `[ZhihuFeedService] Poll complete: ${feedItems.length} raw → ${parsed.length} parsed → ${newCount} new, ${duplicateCount} duplicates, ${totalContent} content fetched (${backfillCount} backfilled)`,
      );

      return { newCount, duplicateCount, totalFetched: feedItems.length, contentCount: totalContent };
    } catch (err) {
      logger.error('[ZhihuFeedService] Poll failed:', { message: err instanceof Error ? err.message : err });
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
    const answerIds = [...contentTargets.values()].filter((i) => i.targetType === 'answer').map((i) => i.targetId);
    const articleIds = [...contentTargets.values()].filter((i) => i.targetType === 'article').map((i) => i.targetId);

    const existingAnswers = this.db.getExistingContentIds('answer', answerIds);
    const existingArticles = this.db.getExistingContentIds('article', articleIds);

    let fetched = 0;
    for (const item of contentTargets.values()) {
      const existing = item.targetType === 'answer' ? existingAnswers : existingArticles;
      if (existing.has(item.targetId)) continue;

      const record = await this.fetchAndFormatContent(item);
      if (record) {
        this.db.upsertContent(record);
        fetched++;
      }
    }

    return fetched;
  }

  /** Backfill content for feed items that exist in DB but have no corresponding content record. */
  private async backfillMissingContent(): Promise<number> {
    const missing = this.db.getFeedItemsMissingContent();
    if (missing.length === 0) return 0;

    logger.info(`[ZhihuFeedService] Backfilling content for ${missing.length} feed items`);

    let fetched = 0;
    for (const row of missing) {
      // Convert DB row to a minimal ZhihuContentItem for fetchAndFormatContent
      const item: ZhihuContentItem = {
        id: row.id,
        feedId: row.feedId,
        verb: row.verb,
        targetType: row.targetType,
        targetId: row.targetId,
        title: row.title,
        excerpt: row.excerpt,
        url: row.url,
        authorName: row.authorName,
        authorUrlToken: row.authorUrlToken,
        authorAvatarUrl: row.authorAvatarUrl ?? undefined,
        voteupCount: row.voteupCount,
        commentCount: row.commentCount,
        actorNames: JSON.parse(row.actorNames || '[]'),
        createdTime: row.createdTime,
        fetchedAt: row.fetchedAt,
        // No rawContent available for old items — API fetch only
      };

      const record = await this.fetchAndFormatContent(item);
      if (record) {
        this.db.upsertContent(record);
        fetched++;
      }
    }

    if (fetched > 0) {
      logger.info(`[ZhihuFeedService] Backfilled ${fetched}/${missing.length} content records`);
    }
    return fetched;
  }

  /** Fetch full content for a single article/answer and format it. Falls back to feed content on API failure. */
  private async fetchAndFormatContent(item: ZhihuContentItem): Promise<ZhihuContentRecord | null> {
    if (item.targetType === 'answer') {
      return this.fetchAnswerContent(item);
    }

    if (item.targetType === 'article') {
      return this.fetchArticleContent(item);
    }

    return null;
  }

  private async fetchAnswerContent(item: ZhihuContentItem): Promise<ZhihuContentRecord | null> {
    // Strategy 1: Direct API fetch (works when cookie is valid and IP not flagged)
    try {
      const answer = await this.client.fetchAnswerContent(item.targetId);
      if (answer?.content) {
        logger.info(`[ZhihuFeedService] API fetch succeeded for answer ${item.targetId}`);
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
    } catch (err) {
      logger.warn(`[ZhihuFeedService] API fetch failed for answer ${item.targetId}:`, {
        message: err instanceof Error ? err.message : err,
      });
    }

    // Strategy 2: use content from the feed response (excerpt only)
    const fallback = this.buildRecordFromFeedContent(item);
    if (!fallback) {
      this.onContentFetchFailed?.(item, 'API failed and no feed content available');
    }
    return fallback;
  }

  private async fetchArticleContent(item: ZhihuContentItem): Promise<ZhihuContentRecord | null> {
    // Strategy 1: Direct API fetch
    try {
      const article = await this.client.fetchArticleContent(item.targetId);
      if (article?.content) {
        logger.info(`[ZhihuFeedService] API fetch succeeded for article ${item.targetId}`);
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
    } catch (err) {
      logger.warn(`[ZhihuFeedService] API fetch failed for article ${item.targetId}:`, {
        message: err instanceof Error ? err.message : err,
      });
    }

    // Strategy 2: use content from the feed response (excerpt only)
    const fallback = this.buildRecordFromFeedContent(item);
    if (!fallback) {
      this.onContentFetchFailed?.(item, 'API failed and no feed content available');
    }
    return fallback;
  }

  /** Build a content record from the feed item's rawContent (fallback when API fetch fails). */
  private buildRecordFromFeedContent(item: ZhihuContentItem): ZhihuContentRecord | null {
    if (!item.rawContent) {
      logger.warn(`[ZhihuFeedService] No feed content available for ${item.targetType} ${item.targetId}, skipping`);
      return null;
    }

    logger.info(
      `[ZhihuFeedService] Using feed content for ${item.targetType} ${item.targetId} (${item.rawContent.length} chars raw)`,
    );
    return {
      targetType: item.targetType,
      targetId: item.targetId,
      title: item.title,
      url: item.url,
      authorName: item.authorName,
      authorUrlToken: item.authorUrlToken,
      authorAvatarUrl: item.authorAvatarUrl,
      content: ZhihuClient.formatContent(item.rawContent),
      excerpt: item.excerpt,
      voteupCount: item.voteupCount,
      commentCount: item.commentCount,
      createdTime: item.createdTime,
      fetchedAt: new Date().toISOString(),
    };
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
