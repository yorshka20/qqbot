// Standalone SQLite persistence for Zhihu feed items
// Writes to data/zhihu.db — completely independent of the core DatabaseManager

import { Database } from 'bun:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuFeedItemRow } from './types';

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
          (id, feedId, verb, targetType, targetId, title, excerpt, content, url,
           authorName, authorUrlToken, authorAvatarUrl, voteupCount, commentCount,
           actorNames, createdTime, fetchedAt, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          item.id,
          item.feedId,
          item.verb,
          item.targetType,
          item.targetId,
          item.title,
          item.excerpt,
          item.content ?? null,
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

  /** Update content for an item (for enrichment). */
  updateContent(itemId: string, content: string): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db
      .query<void, [string, string, string]>('UPDATE zhihu_feed_items SET content = ?, updatedAt = ? WHERE id = ?')
      .run(content, now, itemId);
  }

  // ──────────────────────────────────────────────────
  // Schema
  // ──────────────────────────────────────────────────

  private migrate(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS zhihu_feed_items (
        id              TEXT PRIMARY KEY,
        feedId          TEXT    NOT NULL,
        verb            TEXT    NOT NULL,
        targetType      TEXT    NOT NULL,
        targetId        INTEGER NOT NULL,
        title           TEXT    NOT NULL,
        excerpt         TEXT    NOT NULL DEFAULT '',
        content         TEXT,
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

    logger.debug('[ZhihuDatabase] Schema ready');
  }
}
