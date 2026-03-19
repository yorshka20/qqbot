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
  processed: number; // 0 = unprocessed, 1 = processed (for digest)
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
  // ── Analysis tracking ──────────────────
  analyzed?: number; // 0 = not analyzed, 1 = analyzed (default 0)
}

/** Article insight extracted by LLM analysis */
export interface WeChatArticleInsightRow {
  id?: number;
  articleMsgId: string; // FK → wechat_oa_articles.msgId
  title: string; // article title (denormalized for convenience)
  url: string; // article URL (denormalized)
  source: string; // account nick / source name
  headline: string; // LLM-generated one-line headline
  categoryTags: string; // JSON array of category tags, e.g. '["科技","AI"]'
  items: string; // JSON array of extracted insight items
  worthReporting: number; // 1 = yes, 0 = no (filtered ads/fluff)
  analyzedAt: string; // ISO timestamp of analysis
  model: string; // model used for analysis (e.g. "qwen3:8b")
}

/** Contact info row cached from PadPro API or group member lists */
export interface WeChatContactRow {
  wxid: string; // e.g. "wxid_5vfmwys8g4w521" or "ma-gic"
  nickName: string; // display name
  remark: string; // remark name set by the bot account (friends only)
  updatedAt: string; // ISO timestamp of last sync
}

/** Group / contact info row cached from PadPro API */
export interface WeChatGroupRow {
  chatroomId: string; // e.g. "22443486739@chatroom"
  conversationId: string; // e.g. "22443486739"
  nickName: string; // human-readable group name
  memberCount: number;
  owner: string; // owner wxid
  updatedAt: string; // ISO timestamp of last sync
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
  insert(row: Omit<WeChatMessageRow, 'id' | 'processed'>): void {
    if (!this.db) {
      logger.warn('[WeChatDatabase] insert called before init');
      return;
    }
    try {
      this.db
        .query(`INSERT OR IGNORE INTO wechat_messages
          (newMsgId, conversationId, isGroup, sender, content, rawContent, msgType, category, createTime, receivedAt, processed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
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
  // Write / Read — groups
  // ──────────────────────────────────────────────────

  /** Upsert a group info row. */
  upsertGroup(row: WeChatGroupRow): void {
    if (!this.db) return;
    try {
      this.db
        .query(`INSERT OR REPLACE INTO wechat_groups
          (chatroomId, conversationId, nickName, memberCount, owner, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .run(row.chatroomId, row.conversationId, row.nickName, row.memberCount, row.owner, row.updatedAt);
    } catch (err) {
      logger.error('[WeChatDatabase] upsertGroup error:', err);
    }
  }

  /** Bulk upsert groups. */
  upsertGroups(rows: WeChatGroupRow[]): void {
    for (const row of rows) this.upsertGroup(row);
  }

  /** Get group name by conversationId (e.g. "22443486739"). Returns null if not cached. */
  getGroupName(conversationId: string): string | null {
    if (!this.db) return null;
    const row = this.db
      .query<{ nickName: string }, [string]>(`SELECT nickName FROM wechat_groups WHERE conversationId = ?`)
      .get(conversationId);
    return row?.nickName ?? null;
  }

  /** Get all cached groups. */
  getAllGroups(): WeChatGroupRow[] {
    if (!this.db) return [];
    return this.db.query<WeChatGroupRow, []>(`SELECT * FROM wechat_groups ORDER BY nickName`).all();
  }

  // ──────────────────────────────────────────────────
  // Write / Read — contacts
  // ──────────────────────────────────────────────────

  /** Upsert a single contact. */
  upsertContact(row: WeChatContactRow): void {
    if (!this.db) return;
    try {
      this.db
        .query(`INSERT OR REPLACE INTO wechat_contacts
          (wxid, nickName, remark, updatedAt)
          VALUES (?, ?, ?, ?)`)
        .run(row.wxid, row.nickName, row.remark, row.updatedAt);
    } catch (err) {
      logger.error('[WeChatDatabase] upsertContact error:', err);
    }
  }

  /** Bulk upsert contacts. */
  upsertContacts(rows: WeChatContactRow[]): void {
    if (!this.db || rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO wechat_contacts (wxid, nickName, remark, updatedAt) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
      stmt.run(row.wxid, row.nickName, row.remark, row.updatedAt);
    }
  }

  /** Get display name for a wxid. Returns remark > nickName > null. */
  getContactName(wxid: string): string | null {
    if (!this.db) return null;
    const row = this.db
      .query<{ nickName: string; remark: string }, [string]>(
        `SELECT nickName, remark FROM wechat_contacts WHERE wxid = ?`,
      )
      .get(wxid);
    if (!row) return null;
    return row.remark || row.nickName || null;
  }

  /** Get all cached contacts. */
  getAllContacts(): WeChatContactRow[] {
    if (!this.db) return [];
    return this.db.query<WeChatContactRow, []>(`SELECT * FROM wechat_contacts ORDER BY nickName`).all();
  }

  // ──────────────────────────────────────────────────
  // Digest — query unprocessed messages for daily summary
  // ──────────────────────────────────────────────────

  /**
   * Get unprocessed messages since a given timestamp.
   * @param sinceTs - Unix timestamp (seconds) to start from
   * @param limit - Maximum number of messages to return (default 500)
   */
  getUnprocessedSince(sinceTs: number, limit = 500): WeChatMessageRow[] {
    if (!this.db) return [];
    return this.db
      .query<WeChatMessageRow, [number, number]>(
        `SELECT * FROM wechat_messages
         WHERE processed = 0 AND createTime >= ?
         ORDER BY createTime ASC
         LIMIT ?`,
      )
      .all(sinceTs, limit);
  }

  /**
   * Mark messages as processed (for digest).
   * @param sinceTs - Unix timestamp (seconds); mark all unprocessed messages since this time
   * @returns Number of rows updated
   */
  markProcessedSince(sinceTs: number): number {
    if (!this.db) return 0;
    const result = this.db
      .query<{ changes: number }, [number]>(
        `UPDATE wechat_messages SET processed = 1 WHERE processed = 0 AND createTime >= ?`,
      )
      .run(sinceTs);
    return (result as any).changes ?? 0;
  }

  /**
   * Get the start of today (local timezone) as Unix timestamp (seconds).
   */
  getTodayStartTs(): number {
    const now = new Date();
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  }

  // ──────────────────────────────────────────────────
  // Advanced queries — messages
  // ──────────────────────────────────────────────────

  /**
   * Get messages with flexible filters.
   */
  getMessages(options: {
    sinceTs?: number;
    untilTs?: number;
    conversationId?: string;
    isGroup?: boolean;
    category?: string;
    limit?: number;
  }): WeChatMessageRow[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sinceTs !== undefined) {
      conditions.push('createTime >= ?');
      params.push(options.sinceTs);
    }
    if (options.untilTs !== undefined) {
      conditions.push('createTime <= ?');
      params.push(options.untilTs);
    }
    if (options.conversationId) {
      conditions.push('conversationId = ?');
      params.push(options.conversationId);
    }
    if (options.isGroup !== undefined) {
      conditions.push('isGroup = ?');
      params.push(options.isGroup ? 1 : 0);
    }
    if (options.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 500;

    const sql = `SELECT * FROM wechat_messages ${whereClause} ORDER BY createTime DESC LIMIT ?`;
    params.push(limit);

    return this.db.query<WeChatMessageRow, (string | number)[]>(sql).all(...params);
  }

  /**
   * Get group message statistics since a given time.
   */
  getGroupStats(sinceTs: number): Array<{
    conversationId: string;
    messageCount: number;
    senderCount: number;
    lastTime: number;
    categories: string;
  }> {
    if (!this.db) return [];
    return this.db
      .query<
        {
          conversationId: string;
          messageCount: number;
          senderCount: number;
          lastTime: number;
          categories: string;
        },
        [number]
      >(
        `SELECT
           conversationId,
           COUNT(*) as messageCount,
           COUNT(DISTINCT sender) as senderCount,
           MAX(createTime) as lastTime,
           GROUP_CONCAT(DISTINCT category) as categories
         FROM wechat_messages
         WHERE isGroup = 1 AND createTime >= ?
         GROUP BY conversationId
         ORDER BY messageCount DESC`,
      )
      .all(sinceTs);
  }

  /**
   * Get overall statistics since a given time.
   */
  getOverallStats(sinceTs: number): {
    totalMessages: number;
    groupMessages: number;
    privateMessages: number;
    groupCount: number;
    privateCount: number;
    articleCount: number;
    oaPushCount: number;
    sharedArticleCount: number;
  } {
    if (!this.db) {
      return {
        totalMessages: 0,
        groupMessages: 0,
        privateMessages: 0,
        groupCount: 0,
        privateCount: 0,
        articleCount: 0,
        oaPushCount: 0,
        sharedArticleCount: 0,
      };
    }

    const msgStats = this.db
      .query<
        {
          totalMessages: number;
          groupMessages: number;
          privateMessages: number;
          groupCount: number;
          privateCount: number;
        },
        [number]
      >(`
      SELECT
        COUNT(*) as totalMessages,
        SUM(CASE WHEN isGroup = 1 THEN 1 ELSE 0 END) as groupMessages,
        SUM(CASE WHEN isGroup = 0 THEN 1 ELSE 0 END) as privateMessages,
        COUNT(DISTINCT CASE WHEN isGroup = 1 THEN conversationId END) as groupCount,
        COUNT(DISTINCT CASE WHEN isGroup = 0 THEN conversationId END) as privateCount
      FROM wechat_messages
      WHERE createTime >= ?
    `)
      .get(sinceTs);

    const articleStats = this.db
      .query<
        {
          articleCount: number;
          oaPushCount: number;
          sharedArticleCount: number;
        },
        [number]
      >(`
      SELECT
        COUNT(*) as articleCount,
        SUM(CASE WHEN sourceType = 'oa_push' THEN 1 ELSE 0 END) as oaPushCount,
        SUM(CASE WHEN sourceType != 'oa_push' THEN 1 ELSE 0 END) as sharedArticleCount
      FROM wechat_oa_articles
      WHERE pubTime >= ?
    `)
      .get(sinceTs);

    return {
      totalMessages: msgStats?.totalMessages ?? 0,
      groupMessages: msgStats?.groupMessages ?? 0,
      privateMessages: msgStats?.privateMessages ?? 0,
      groupCount: msgStats?.groupCount ?? 0,
      privateCount: msgStats?.privateCount ?? 0,
      articleCount: articleStats?.articleCount ?? 0,
      oaPushCount: articleStats?.oaPushCount ?? 0,
      sharedArticleCount: articleStats?.sharedArticleCount ?? 0,
    };
  }

  /**
   * Search messages by keyword (full-text search in content).
   */
  searchMessages(
    keyword: string,
    options?: {
      sinceTs?: number;
      isGroup?: boolean;
      limit?: number;
    },
  ): WeChatMessageRow[] {
    if (!this.db) return [];

    const conditions: string[] = ['content LIKE ?'];
    const params: (string | number)[] = [`%${keyword}%`];

    if (options?.sinceTs !== undefined) {
      conditions.push('createTime >= ?');
      params.push(options.sinceTs);
    }
    if (options?.isGroup !== undefined) {
      conditions.push('isGroup = ?');
      params.push(options.isGroup ? 1 : 0);
    }

    const limit = options?.limit ?? 100;
    const sql = `SELECT * FROM wechat_messages WHERE ${conditions.join(' AND ')} ORDER BY createTime DESC LIMIT ?`;
    params.push(limit);

    return this.db.query<WeChatMessageRow, (string | number)[]>(sql).all(...params);
  }

  // ──────────────────────────────────────────────────
  // Advanced queries — articles
  // ──────────────────────────────────────────────────

  /**
   * Get articles with flexible filters.
   */
  getArticles(options: {
    sinceTs?: number;
    untilTs?: number;
    sourceType?: 'oa_push' | 'group_chat' | 'private_chat';
    accountId?: string;
    keyword?: string;
    analyzed?: boolean;
    limit?: number;
  }): WeChatOAArticleRow[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sinceTs !== undefined) {
      conditions.push('pubTime >= ?');
      params.push(options.sinceTs);
    }
    if (options.untilTs !== undefined) {
      conditions.push('pubTime <= ?');
      params.push(options.untilTs);
    }
    if (options.sourceType) {
      conditions.push('sourceType = ?');
      params.push(options.sourceType);
    }
    if (options.accountId) {
      conditions.push('accountId = ?');
      params.push(options.accountId);
    }
    if (options.keyword) {
      conditions.push('(title LIKE ? OR summary LIKE ? OR accountNick LIKE ?)');
      const like = `%${options.keyword}%`;
      params.push(like, like, like);
    }
    if (options.analyzed !== undefined) {
      conditions.push('analyzed = ?');
      params.push(options.analyzed ? 1 : 0);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;

    const sql = `SELECT * FROM wechat_oa_articles ${whereClause} ORDER BY pubTime DESC LIMIT ?`;
    params.push(limit);

    return this.db.query<WeChatOAArticleRow, (string | number)[]>(sql).all(...params);
  }

  /**
   * Get article statistics by source/account.
   */
  getArticleStats(sinceTs: number): Array<{
    accountNick: string;
    accountId: string;
    articleCount: number;
    lastPubTime: number;
  }> {
    if (!this.db) return [];
    return this.db
      .query<
        {
          accountNick: string;
          accountId: string;
          articleCount: number;
          lastPubTime: number;
        },
        [number]
      >(
        `SELECT
           accountNick,
           accountId,
           COUNT(*) as articleCount,
           MAX(pubTime) as lastPubTime
         FROM wechat_oa_articles
         WHERE pubTime >= ?
         GROUP BY accountId
         ORDER BY articleCount DESC`,
      )
      .all(sinceTs);
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
  // Write / Read — article insights (LLM analysis results)
  // ──────────────────────────────────────────────────

  /** Insert an article insight row. Silently ignores duplicates (same articleMsgId). */
  insertArticleInsight(row: Omit<WeChatArticleInsightRow, 'id'>): void {
    if (!this.db) return;
    try {
      this.db
        .query(`INSERT OR REPLACE INTO wechat_article_insights
          (articleMsgId, title, url, source, headline, categoryTags, items, worthReporting, analyzedAt, model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.articleMsgId,
          row.title,
          row.url,
          row.source,
          row.headline,
          row.categoryTags,
          row.items,
          row.worthReporting,
          row.analyzedAt,
          row.model,
        );
    } catch (err) {
      logger.error('[WeChatDatabase] insertArticleInsight error:', err);
    }
  }

  /** Get article insights with filters. Only returns worthReporting=1 by default. */
  getArticleInsights(options: {
    sinceTs?: number;
    untilTs?: number;
    worthOnly?: boolean;
    limit?: number;
  }): WeChatArticleInsightRow[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.worthOnly !== false) {
      conditions.push('i.worthReporting = 1');
    }
    if (options.sinceTs !== undefined) {
      conditions.push('a.pubTime >= ?');
      params.push(options.sinceTs);
    }
    if (options.untilTs !== undefined) {
      conditions.push('a.pubTime <= ?');
      params.push(options.untilTs);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 200;

    const sql = `SELECT i.* FROM wechat_article_insights i
      JOIN wechat_oa_articles a ON a.msgId = i.articleMsgId
      ${whereClause}
      ORDER BY a.pubTime DESC LIMIT ?`;
    params.push(limit);

    return this.db.query<WeChatArticleInsightRow, (string | number)[]>(sql).all(...params);
  }

  /** Get article msgIds that already have insights (for skipping re-analysis). */
  getAnalyzedArticleIds(sinceTs?: number): Set<string> {
    if (!this.db) return new Set();
    const conditions = sinceTs !== undefined ? 'WHERE analyzedAt >= ?' : '';
    const params = sinceTs !== undefined ? [new Date(sinceTs * 1000).toISOString()] : [];
    const rows = this.db
      .query<{ articleMsgId: string }, string[]>(`SELECT articleMsgId FROM wechat_article_insights ${conditions}`)
      .all(...params);
    return new Set(rows.map((r) => r.articleMsgId));
  }

  /** Mark an article as analyzed in the articles table. */
  markArticleAnalyzed(msgId: string): void {
    if (!this.db) return;
    this.db.query<void, [string]>(`UPDATE wechat_oa_articles SET analyzed = 1 WHERE msgId = ?`).run(msgId);
  }

  /** Batch mark articles as analyzed. */
  markArticlesAnalyzed(msgIds: string[]): void {
    if (!this.db || msgIds.length === 0) return;
    const stmt = this.db.query<void, [string]>(`UPDATE wechat_oa_articles SET analyzed = 1 WHERE msgId = ?`);
    for (const msgId of msgIds) {
      stmt.run(msgId);
    }
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
        receivedAt     TEXT    NOT NULL DEFAULT '',
        processed      INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_conversation ON wechat_messages(conversationId)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_createTime   ON wechat_messages(createTime)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_category     ON wechat_messages(category)`);
    // Migrate existing DBs: add processed column BEFORE creating index on it
    try {
      this.db.run(`ALTER TABLE wechat_messages ADD COLUMN processed INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_processed    ON wechat_messages(processed)`);

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
      try {
        this.db.run(col);
      } catch {
        /* column already exists — ignore */
      }
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_sourceType  ON wechat_oa_articles(sourceType)`);
    // Migrate: add analyzed column for tracking analysis status
    try {
      this.db.run(`ALTER TABLE wechat_oa_articles ADD COLUMN analyzed INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_analyzed    ON wechat_oa_articles(analyzed)`);

    // Group info cache (synced from PadPro API)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_groups (
        chatroomId     TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL UNIQUE,
        nickName       TEXT NOT NULL DEFAULT '',
        memberCount    INTEGER NOT NULL DEFAULT 0,
        owner          TEXT NOT NULL DEFAULT '',
        updatedAt      TEXT NOT NULL DEFAULT ''
      )
    `);

    // Contact info cache (synced from PadPro API group member lists and friend list)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_contacts (
        wxid       TEXT PRIMARY KEY,
        nickName   TEXT NOT NULL DEFAULT '',
        remark     TEXT NOT NULL DEFAULT '',
        updatedAt  TEXT NOT NULL DEFAULT ''
      )
    `);

    // Article insights (LLM analysis results)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_article_insights (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        articleMsgId    TEXT    NOT NULL UNIQUE,
        title           TEXT    NOT NULL DEFAULT '',
        url             TEXT    NOT NULL DEFAULT '',
        source          TEXT    NOT NULL DEFAULT '',
        headline        TEXT    NOT NULL DEFAULT '',
        categoryTags    TEXT    NOT NULL DEFAULT '[]',
        items           TEXT    NOT NULL DEFAULT '[]',
        worthReporting  INTEGER NOT NULL DEFAULT 0,
        analyzedAt      TEXT    NOT NULL DEFAULT '',
        model           TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_analyzedAt      ON wechat_article_insights(analyzedAt)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_worthReporting   ON wechat_article_insights(worthReporting)`);

    logger.debug('[WeChatDatabase] Schema ready');
  }
}
