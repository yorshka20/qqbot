// WeChatArticleCleanupService — periodically removes expired (non-evergreen) article data
// from both Qdrant RAG collections and SQLite to prevent unbounded growth.

import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import type { WeChatDatabase } from '../WeChatDatabase';

const TAG = '[ArticleCleanup]';

/** How often the cleanup timer fires (once per day). */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ArticleCleanupConfig {
  /** Days to retain non-evergreen articles. 0 = disabled. */
  retentionDays: number;
  /** Qdrant collection for full article vectors (legacy). */
  articleCollection: string;
  /** Qdrant collection for article chunks. */
  chunksCollection: string;
}

export class WeChatArticleCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: WeChatDatabase,
    private retrieval: RetrievalService,
    private config: ArticleCleanupConfig,
  ) {}

  /**
   * Start the periodic cleanup timer. Runs an initial cleanup immediately.
   */
  start(): void {
    if (this.config.retentionDays <= 0) {
      logger.info(`${TAG} Disabled (articleRetentionDays=0)`);
      return;
    }

    logger.info(`${TAG} Started | retention=${this.config.retentionDays}d interval=24h`);

    // Run once on startup (delayed 30s to let other services init)
    setTimeout(() => this.runCleanup(), 30_000);

    // Then run daily
    this.timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute one cleanup pass: find expired articles, delete from Qdrant + SQLite.
   */
  async runCleanup(): Promise<{ deleted: number }> {
    const cutoffTs = Math.floor(Date.now() / 1000) - this.config.retentionDays * 86400;

    // 1. Get expired article msgIds from SQLite (non-evergreen, older than cutoff)
    const expiredIds = this.db.getExpiredArticleMsgIds(cutoffTs);
    if (expiredIds.length === 0) {
      logger.debug(`${TAG} No expired articles found`);
      return { deleted: 0 };
    }

    logger.info(
      `${TAG} Found ${expiredIds.length} expired articles (before ${new Date(cutoffTs * 1000).toISOString()})`,
    );

    // 2. Delete from Qdrant — both legacy articleCollection and chunksCollection
    //    Use articleId payload filter to match all chunks belonging to each article.
    //    Process in batches to avoid overly large filter queries.
    const BATCH_SIZE = 50;
    let qdrantDeleted = 0;

    for (let i = 0; i < expiredIds.length; i += BATCH_SIZE) {
      const batch = expiredIds.slice(i, i + BATCH_SIZE);
      const filter = {
        should: batch.map((id) => ({
          key: 'articleId',
          match: { value: id },
        })),
      };

      try {
        // Delete from chunks collection
        await this.retrieval.deleteByFilter(this.config.chunksCollection, filter);
        qdrantDeleted += batch.length;
      } catch (err) {
        logger.error(`${TAG} Failed to delete chunks batch ${i}-${i + batch.length} from Qdrant:`, err);
      }

      try {
        // Delete from legacy article collection (may not exist, that's fine)
        await this.retrieval.deleteByFilter(this.config.articleCollection, filter);
      } catch {
        // Legacy collection may not exist — ignore silently
      }
    }

    // 3. Delete from SQLite (articles + insights)
    const sqliteDeleted = this.db.deleteArticlesByMsgIds(expiredIds);

    logger.info(`${TAG} Cleanup complete | qdrant=${qdrantDeleted} sqlite=${sqliteDeleted} articles removed`);

    return { deleted: expiredIds.length };
  }
}
