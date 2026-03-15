// Standalone SQLite persistence for WeChat messages
// Writes to data/wechat.db — completely independent of the core DatabaseManager

import { Database } from 'bun:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Row types
// ────────────────────────────────────────────────────────────────────────────

/** Chat message row (group or private) */
export interface WeChatMessageRow {
  id?: number; // auto-increment primary key
  newMsgId: string; // WeChatPadPro NewMsgId (unique)
  conversationId: string; // group chatroom-ID or private wxid
  isGroup: number; // 1 = group, 0 = private
  sender: string; // sender nickname or wxid
  content: string; // structured JSON (see parseContentAsJson)
  rawContent: string; // original Content field (may be XML)
  msgType: number; // WeChatPadPro MsgType
  category: string; // text | image | file | other
  createTime: number; // unix seconds (from webhook CreateTime)
  receivedAt: string; // ISO timestamp when bot received the message
}

/** One article row in wechat_oa_articles (one row per article, not per push) */
export interface WeChatOAArticleRow {
  id?: number; // auto-increment primary key
  msgId: string; // `${NewMsgId}_${idx}` for OA push, `${NewMsgId}` for chat share — unique per article
  accountId: string; // gh_xxx wxid of the official account
  accountNick: string; // display name of the official account
  title: string;
  url: string;
  summary: string; // excerpt from <summary> or <des>
  cover: string; // cover image URL
  source: string; // inner account name from <sources><source><name> or <appname>
  pubTime: number; // article publish time (unix seconds)
  receivedAt: string; // ISO timestamp when bot received the message
  // ── Source tracking (new fields) ──────────────────
  sourceType: string; // 'oa_push' | 'group_chat' | 'private_chat'
  fromConversationId: string; // group chatroom-ID or private wxid (empty for oa_push)
  fromSender: string; // wxid/nickname of who shared it in chat (empty for oa_push)
}

// ────────────────────────────────────────────────────────────────────────────
// WeChatDatabase
// ────────────────────────────────────────────────────────────────────────────

export class WeChatDatabase {
  private db: Database | null = null;

  async init(dbPath = 'data/wechat.db'): Promise<void> {
    // ':memory:' is the SQLite in-memory identifier — skip path resolution
    const isMemory = dbPath === ':memory:';
    const resolved = isMemory ? ':memory:' : resolve(dbPath);

    if (!isMemory) {
      const dir = dirname(resolved);
      try {
        await stat(dir);
      } catch {
        await mkdir(dir, { recursive: true });
        logger.info(`[WeChatDatabase] Created directory: ${dir}`);
      }
    }

    this.db = new Database(resolved);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
    logger.info(`[WeChatDatabase] Opened: ${resolved}`);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ──────────────────────────────────────────────────
  // Write — chat messages
  // ──────────────────────────────────────────────────

  /** Insert a chat message. Silently ignores duplicates (ON CONFLICT IGNORE). */
  insert(row: Omit<WeChatMessageRow, 'id'>): void {
    if (!this.db) {
      logger.warn('[WeChatDatabase] insert called before init');
      return;
    }
    try {
      this.db
        .query(`INSERT OR IGNORE INTO wechat_messages
          (newMsgId, conversationId, isGroup, sender, content, rawContent, msgType, category, createTime, receivedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.newMsgId,
          row.conversationId,
          row.isGroup,
          row.sender,
          row.content,
          row.rawContent,
          row.msgType,
          row.category,
          row.createTime,
          row.receivedAt,
        );
    } catch (err) {
      logger.error('[WeChatDatabase] insert error:', err);
    }
  }

  // ──────────────────────────────────────────────────
  // Write — official account articles
  // ──────────────────────────────────────────────────

  /** Update the content JSON for a row (e.g., add filePath after image download). */
  updateContentByMsgId(newMsgId: string, content: string): void {
    if (!this.db) return;
    this.db
      .query<void, [string, string]>(`UPDATE wechat_messages SET content = ? WHERE newMsgId = ?`)
      .run(content, newMsgId);
  }

  /** Insert an OA article. Silently ignores duplicates. */
  insertOAArticle(row: Omit<WeChatOAArticleRow, 'id'>): void {
    if (!this.db) {
      logger.warn('[WeChatDatabase] insertOAArticle called before init');
      return;
    }
    try {
      this.db
        .query(`INSERT OR IGNORE INTO wechat_oa_articles
          (msgId, accountId, accountNick, title, url, summary, cover, source, pubTime, receivedAt,
           sourceType, fromConversationId, fromSender)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.msgId,
          row.accountId,
          row.accountNick,
          row.title,
          row.url,
          row.summary,
          row.cover,
          row.source,
          row.pubTime,
          row.receivedAt,
          row.sourceType,
          row.fromConversationId,
          row.fromSender,
        );
    } catch (err) {
      logger.error('[WeChatDatabase] insertOAArticle error:', err);
    }
  }

  // ──────────────────────────────────────────────────
  // Read — chat messages
  // ──────────────────────────────────────────────────

  getRecentByConversation(conversationId: string, limit = 50): WeChatMessageRow[] {
    if (!this.db) return [];
    return this.db
      .query<WeChatMessageRow, [string, number]>(
        `SELECT * FROM wechat_messages WHERE conversationId = ? ORDER BY createTime DESC LIMIT ?`,
      )
      .all(conversationId, limit);
  }

  getTotalCount(): number {
    if (!this.db) return 0;
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM wechat_messages`).get();
    return row?.n ?? 0;
  }

  getConversationSummary(): Array<{ conversationId: string; isGroup: number; count: number; lastTime: number }> {
    if (!this.db) return [];
    return this.db
      .query<{ conversationId: string; isGroup: number; count: number; lastTime: number }, []>(
        `SELECT conversationId, isGroup, COUNT(*) as count, MAX(createTime) as lastTime
         FROM wechat_messages
         GROUP BY conversationId
         ORDER BY lastTime DESC`,
      )
      .all();
  }

  // ──────────────────────────────────────────────────
  // Read — official account articles
  // ──────────────────────────────────────────────────

  /**
   * Return recently received OA articles.
   * @param limit  max rows to return
   * @param keyword  optional filter matched against title OR accountNick OR source
   */
  getRecentOAArticles(limit = 20, keyword?: string): WeChatOAArticleRow[] {
    if (!this.db) return [];
    if (keyword) {
      const like = `%${keyword}%`;
      return this.db
        .query<WeChatOAArticleRow, [string, string, string, number]>(
          `SELECT * FROM wechat_oa_articles
           WHERE title LIKE ? OR accountNick LIKE ? OR source LIKE ?
           ORDER BY pubTime DESC LIMIT ?`,
        )
        .all(like, like, like, limit);
    }
    return this.db
      .query<WeChatOAArticleRow, [number]>(`SELECT * FROM wechat_oa_articles ORDER BY pubTime DESC LIMIT ?`)
      .all(limit);
  }

  // ──────────────────────────────────────────────────
  // Schema
  // ──────────────────────────────────────────────────

  private migrate(): void {
    if (!this.db) return;

    // Chat messages (group + private)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        newMsgId       TEXT    NOT NULL UNIQUE,
        conversationId TEXT    NOT NULL,
        isGroup        INTEGER NOT NULL DEFAULT 0,
        sender         TEXT    NOT NULL DEFAULT '',
        content        TEXT    NOT NULL DEFAULT '',
        rawContent     TEXT    NOT NULL DEFAULT '',
        msgType        INTEGER NOT NULL DEFAULT 1,
        category       TEXT    NOT NULL DEFAULT 'other',
        createTime     INTEGER NOT NULL DEFAULT 0,
        receivedAt     TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_conversation ON wechat_messages(conversationId)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_createTime   ON wechat_messages(createTime)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_category     ON wechat_messages(category)`);

    // Official account articles (one row per article, not per push)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_oa_articles (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        msgId              TEXT    NOT NULL UNIQUE,
        accountId          TEXT    NOT NULL DEFAULT '',
        accountNick        TEXT    NOT NULL DEFAULT '',
        title              TEXT    NOT NULL DEFAULT '',
        url                TEXT    NOT NULL DEFAULT '',
        summary            TEXT    NOT NULL DEFAULT '',
        cover              TEXT    NOT NULL DEFAULT '',
        source             TEXT    NOT NULL DEFAULT '',
        pubTime            INTEGER NOT NULL DEFAULT 0,
        receivedAt         TEXT    NOT NULL DEFAULT '',
        sourceType         TEXT    NOT NULL DEFAULT 'oa_push',
        fromConversationId TEXT    NOT NULL DEFAULT '',
        fromSender         TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_accountId   ON wechat_oa_articles(accountId)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_pubTime     ON wechat_oa_articles(pubTime)`);
    // Migrate existing DBs: add new columns before creating indexes that depend on them
    for (const col of [
      `ALTER TABLE wechat_oa_articles ADD COLUMN sourceType         TEXT NOT NULL DEFAULT 'oa_push'`,
      `ALTER TABLE wechat_oa_articles ADD COLUMN fromConversationId TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE wechat_oa_articles ADD COLUMN fromSender         TEXT NOT NULL DEFAULT ''`,
    ]) {
      try { this.db.run(col); } catch { /* column already exists — ignore */ }
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_sourceType  ON wechat_oa_articles(sourceType)`);

    logger.debug('[WeChatDatabase] Schema ready');
  }
}
