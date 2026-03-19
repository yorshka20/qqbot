// Standalone SQLite persistence for Zhihu feed items and content
// Writes to data/zhihu.db — completely independent of the core DatabaseManager
//
// Two tables:
//   zhihu_feed_items  — one row per feed event (vote, create, follow, etc.)
//   zhihu_contents    — one row per unique article/answer (stores full content)

import { Database } from 'bun:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuContentRecord, ZhihuContentRow, ZhihuFeedItemRow } from './types';

export class ZhihuDatabase {
  private db: Database | null = null;

  async init(dbPath = 'data/zhihu.db'): Promise<void> {
    const isMemory = dbPath === ':memory:';
    const resolved = isMemory ? ':memory:' : resolve(dbPath);

    if (!isMemory) {
      const dir = dirname(resolved);
      try {
        await stat(dir);
      } catch {
        await mkdir(dir, { recursive: true });
        logger.info(`[ZhihuDatabase] Created directory: ${dir}`);
      }
    }

    this.db = new Database(resolved);
    this.db.run('PRAGMA journal_mode = WAL');
    this.migrate();
    logger.info(`[ZhihuDatabase] Opened: ${resolved}`);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ──────────────────────────────────────────────────
  // Write — feed items
  // ──────────────────────────────────────────────────

  /** Insert a feed item. Silently ignores duplicates (ON CONFLICT IGNORE). */
  insertItem(item: ZhihuContentItem): boolean {
    if (!this.db) {
      logger.warn('[ZhihuDatabase] insertItem called before init');
      return false;
    }
    try {
      const now = new Date().toISOString();
      const result = this.db
        .query(`INSERT OR IGNORE INTO zhihu_feed_items
          (id, feedId, verb, targetType, targetId, title, excerpt, url,
           authorName, authorUrlToken, authorAvatarUrl, voteupCount, commentCount,
           actorNames, createdTime, fetchedAt, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          item.id,
          item.feedId,
          item.verb,
          item.targetType,
          item.targetId,
          item.title,
          item.excerpt,
          item.url,
          item.authorName,
          item.authorUrlToken,
          item.authorAvatarUrl ?? null,
          item.voteupCount,
          item.commentCount,
          JSON.stringify(item.actorNames),
          item.createdTime,
          item.fetchedAt,
          now,
          now,
        );
      return (result as unknown as { changes: number }).changes > 0;
    } catch (err) {
      logger.error('[ZhihuDatabase] insertItem error:', err);
      return false;
    }
  }

  /** Insert multiple items, returns count of newly inserted. */
  insertItems(items: ZhihuContentItem[]): number {
    let count = 0;
    for (const item of items) {
      if (this.insertItem(item)) count++;
    }
    return count;
  }

  // ──────────────────────────────────────────────────
  // Write — contents
  // ──────────────────────────────────────────────────

  /** Upsert a content record (article/answer). Updates if already exists. */
  upsertContent(record: ZhihuContentRecord): boolean {
    if (!this.db) return false;
    try {
      const now = new Date().toISOString();
      const result = this.db
        .query(`INSERT INTO zhihu_contents
          (targetType, targetId, title, url, authorName, authorUrlToken, authorAvatarUrl,
           content, excerpt, voteupCount, commentCount, questionId, questionTitle,
           createdTime, fetchedAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(targetType, targetId) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            excerpt = excluded.excerpt,
            voteupCount = excluded.voteupCount,
            commentCount = excluded.commentCount,
            authorAvatarUrl = excluded.authorAvatarUrl,
            updatedAt = excluded.updatedAt`)
        .run(
          record.targetType,
          record.targetId,
          record.title,
          record.url,
          record.authorName,
          record.authorUrlToken,
          record.authorAvatarUrl ?? null,
          record.content,
          record.excerpt,
          record.voteupCount,
          record.commentCount,
          record.questionId ?? null,
          record.questionTitle ?? null,
          record.createdTime,
          record.fetchedAt,
          now,
        );
      return (result as unknown as { changes: number }).changes > 0;
    } catch (err) {
      logger.error('[ZhihuDatabase] upsertContent error:', err);
      return false;
    }
  }

  /** Check if content already exists for a given target. */
  hasContent(targetType: string, targetId: number): boolean {
    if (!this.db) return false;
    const row = this.db
      .query<{ n: number }, [string, number]>(
        'SELECT COUNT(*) as n FROM zhihu_contents WHERE targetType = ? AND targetId = ?',
      )
      .get(targetType, targetId);
    return (row?.n ?? 0) > 0;
  }

  // ──────────────────────────────────────────────────
  // Read — feed items
  // ──────────────────────────────────────────────────

  /** Check if an item already exists. */
  exists(itemId: string): boolean {
    if (!this.db) return false;
    const row = this.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) as n FROM zhihu_feed_items WHERE id = ?')
      .get(itemId);
    return (row?.n ?? 0) > 0;
  }

  /** Get recent items, optionally filtered by verb. */
  getRecentItems(limit = 20, verb?: string): ZhihuFeedItemRow[] {
    if (!this.db) return [];
    if (verb) {
      return this.db
        .query<ZhihuFeedItemRow, [string, number]>(
          'SELECT * FROM zhihu_feed_items WHERE verb = ? ORDER BY createdTime DESC LIMIT ?',
        )
        .all(verb, limit);
    }
    return this.db
      .query<ZhihuFeedItemRow, [number]>('SELECT * FROM zhihu_feed_items ORDER BY createdTime DESC LIMIT ?')
      .all(limit);
  }

  /** Get items since a timestamp that haven't been digested yet. */
  getUndigestedSince(sinceTs: number, limit = 500): ZhihuFeedItemRow[] {
    if (!this.db) return [];
    return this.db
      .query<ZhihuFeedItemRow, [number, number]>(
        `SELECT * FROM zhihu_feed_items
         WHERE createdTime >= ? AND digestedAt IS NULL
         ORDER BY createdTime ASC LIMIT ?`,
      )
      .all(sinceTs, limit);
  }

  /** Get items since a timestamp (regardless of digest status). */
  getItemsSince(sinceTs: number, limit = 500): ZhihuFeedItemRow[] {
    if (!this.db) return [];
    return this.db
      .query<ZhihuFeedItemRow, [number, number]>(
        'SELECT * FROM zhihu_feed_items WHERE createdTime >= ? ORDER BY createdTime DESC LIMIT ?',
      )
      .all(sinceTs, limit);
  }

  /** Mark items as digested. */
  markDigested(itemIds: string[]): number {
    if (!this.db || itemIds.length === 0) return 0;
    const now = new Date().toISOString();
    let count = 0;
    for (const id of itemIds) {
      const result = this.db
        .query<void, [string, string, string]>('UPDATE zhihu_feed_items SET digestedAt = ?, updatedAt = ? WHERE id = ?')
        .run(now, now, id);
      count += (result as unknown as { changes: number }).changes;
    }
    return count;
  }

  /** Get the most recent createdTime in the database. Returns 0 if empty. */
  getLastFetchTimestamp(): number {
    if (!this.db) return 0;
    const row = this.db
      .query<{ maxTime: number | null }, []>('SELECT MAX(createdTime) as maxTime FROM zhihu_feed_items')
      .get();
    return row?.maxTime ?? 0;
  }

  /** Get total item count. */
  getTotalCount(): number {
    if (!this.db) return 0;
    const row = this.db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM zhihu_feed_items').get();
    return row?.n ?? 0;
  }

  /** Get item count by verb. */
  getCountByVerb(): Array<{ verb: string; count: number }> {
    if (!this.db) return [];
    return this.db
      .query<{ verb: string; count: number }, []>(
        'SELECT verb, COUNT(*) as count FROM zhihu_feed_items GROUP BY verb ORDER BY count DESC',
      )
      .all();
  }

  // ──────────────────────────────────────────────────
  // Read — contents
  // ──────────────────────────────────────────────────

  /** Get content by targetType + targetId. */
  getContent(targetType: string, targetId: number): ZhihuContentRow | null {
    if (!this.db) return null;
    return (
      this.db
        .query<ZhihuContentRow, [string, number]>(
          'SELECT * FROM zhihu_contents WHERE targetType = ? AND targetId = ?',
        )
        .get(targetType, targetId) ?? null
    );
  }

  /** Get recent contents, optionally filtered by targetType. */
  getRecentContents(limit = 20, targetType?: string): ZhihuContentRow[] {
    if (!this.db) return [];
    if (targetType) {
      return this.db
        .query<ZhihuContentRow, [string, number]>(
          'SELECT * FROM zhihu_contents WHERE targetType = ? ORDER BY createdTime DESC LIMIT ?',
        )
        .all(targetType, limit);
    }
    return this.db
      .query<ZhihuContentRow, [number]>('SELECT * FROM zhihu_contents ORDER BY createdTime DESC LIMIT ?')
      .all(limit);
  }

  /** Search contents by title keyword. */
  searchContents(keyword: string, limit = 50): ZhihuContentRow[] {
    if (!this.db) return [];
    const pattern = `%${keyword}%`;
    return this.db
      .query<ZhihuContentRow, [string, string, number]>(
        `SELECT * FROM zhihu_contents
         WHERE title LIKE ? OR excerpt LIKE ?
         ORDER BY createdTime DESC LIMIT ?`,
      )
      .all(pattern, pattern, limit);
  }

  /** Get contents since a timestamp. */
  getContentsSince(sinceTs: number, limit = 500, targetType?: string): ZhihuContentRow[] {
    if (!this.db) return [];
    if (targetType) {
      return this.db
        .query<ZhihuContentRow, [number, string, number]>(
          'SELECT * FROM zhihu_contents WHERE createdTime >= ? AND targetType = ? ORDER BY createdTime DESC LIMIT ?',
        )
        .all(sinceTs, targetType, limit);
    }
    return this.db
      .query<ZhihuContentRow, [number, number]>(
        'SELECT * FROM zhihu_contents WHERE createdTime >= ? ORDER BY createdTime DESC LIMIT ?',
      )
      .all(sinceTs, limit);
  }

  /** Get total content count. */
  getContentCount(targetType?: string): number {
    if (!this.db) return 0;
    if (targetType) {
      const row = this.db
        .query<{ n: number }, [string]>('SELECT COUNT(*) as n FROM zhihu_contents WHERE targetType = ?')
        .get(targetType);
      return row?.n ?? 0;
    }
    const row = this.db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM zhihu_contents').get();
    return row?.n ?? 0;
  }

  /** Get unique targetIds that already have content (for dedup during poll). */
  getExistingContentIds(targetType: string, targetIds: number[]): Set<number> {
    if (!this.db || targetIds.length === 0) return new Set();
    // For small batches, use IN clause
    const placeholders = targetIds.map(() => '?').join(',');
    const params: (string | number)[] = [targetType, ...targetIds];
    const rows = this.db
      .query<{ targetId: number }, (string | number)[]>(
        `SELECT targetId FROM zhihu_contents WHERE targetType = ? AND targetId IN (${placeholders})`,
      )
      .all(...params);
    return new Set(rows.map((r) => r.targetId));
  }

  /** Get feed items that have content-bearing types (article/answer) but no corresponding content record. */
  getFeedItemsMissingContent(limit = 50): ZhihuFeedItemRow[] {
    if (!this.db) return [];
    return this.db
      .query<ZhihuFeedItemRow, [number]>(
        `SELECT f.* FROM zhihu_feed_items f
         LEFT JOIN zhihu_contents c ON f.targetType = c.targetType AND f.targetId = c.targetId
         WHERE f.targetType IN ('article', 'answer') AND c.targetId IS NULL
         ORDER BY f.createdTime DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Get content stats grouped by targetType. */
  getContentStats(): Array<{ targetType: string; count: number }> {
    if (!this.db) return [];
    return this.db
      .query<{ targetType: string; count: number }, []>(
        'SELECT targetType, COUNT(*) as count FROM zhihu_contents GROUP BY targetType ORDER BY count DESC',
      )
      .all();
  }

  // ──────────────────────────────────────────────────
  // Schema
  // ──────────────────────────────────────────────────

  private migrate(): void {
    if (!this.db) return;

    // Feed events table (no content column — content is in zhihu_contents)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS zhihu_feed_items (
        id              TEXT PRIMARY KEY,
        feedId          TEXT    NOT NULL,
        verb            TEXT    NOT NULL,
        targetType      TEXT    NOT NULL,
        targetId        INTEGER NOT NULL,
        title           TEXT    NOT NULL,
        excerpt         TEXT    NOT NULL DEFAULT '',
        url             TEXT    NOT NULL,
        authorName      TEXT    NOT NULL DEFAULT '',
        authorUrlToken  TEXT    NOT NULL DEFAULT '',
        authorAvatarUrl TEXT,
        voteupCount     INTEGER NOT NULL DEFAULT 0,
        commentCount    INTEGER NOT NULL DEFAULT 0,
        actorNames      TEXT    NOT NULL DEFAULT '[]',
        createdTime     INTEGER NOT NULL,
        fetchedAt       TEXT    NOT NULL,
        digestedAt      TEXT,
        createdAt       TEXT    NOT NULL,
        updatedAt       TEXT    NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_feed_createdTime ON zhihu_feed_items(createdTime)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_feed_verb ON zhihu_feed_items(verb)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_feed_digestedAt ON zhihu_feed_items(digestedAt)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_feed_targetId ON zhihu_feed_items(targetType, targetId)');

    // Content table — one row per unique article/answer
    this.db.run(`
      CREATE TABLE IF NOT EXISTS zhihu_contents (
        targetType      TEXT    NOT NULL,
        targetId        INTEGER NOT NULL,
        title           TEXT    NOT NULL,
        url             TEXT    NOT NULL,
        authorName      TEXT    NOT NULL DEFAULT '',
        authorUrlToken  TEXT    NOT NULL DEFAULT '',
        authorAvatarUrl TEXT,
        content         TEXT    NOT NULL DEFAULT '',
        excerpt         TEXT    NOT NULL DEFAULT '',
        voteupCount     INTEGER NOT NULL DEFAULT 0,
        commentCount    INTEGER NOT NULL DEFAULT 0,
        questionId      INTEGER,
        questionTitle   TEXT,
        createdTime     INTEGER NOT NULL,
        fetchedAt       TEXT    NOT NULL,
        updatedAt       TEXT    NOT NULL,
        PRIMARY KEY (targetType, targetId)
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_contents_createdTime ON zhihu_contents(createdTime)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_zhihu_contents_targetType ON zhihu_contents(targetType)');

    // Migration: drop old 'content' column from feed_items if it exists
    // SQLite doesn't support DROP COLUMN before 3.35.0, but we can just leave it
    // The column won't be populated going forward — new data uses zhihu_contents

    logger.debug('[ZhihuDatabase] Schema ready');
  }
}
