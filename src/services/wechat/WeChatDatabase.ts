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
  // ── Account category (populated by LLM or manual assignment) ──
  accountCategory?: string; // e.g. '新闻', '财经', '哲学', '' = unclassified
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
  evergreen: number; // 1 = long-term value (tutorial/knowledge), 0 = time-sensitive (news)
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
           sourceType, fromConversationId, fromSender, accountCategory)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          row.accountCategory ?? '',
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

  /** Get group name + updatedAt for staleness check. Returns null if not cached. */
  getGroupWithTimestamp(conversationId: string): { nickName: string; updatedAt: string } | null {
    if (!this.db) return null;
    return (
      this.db
        .query<{ nickName: string; updatedAt: string }, [string]>(
          `SELECT nickName, updatedAt FROM wechat_groups WHERE conversationId = ?`,
        )
        .get(conversationId) ?? null
    );
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

  /** Get article analysis progress: total, analyzed, remaining. */
  getArticleAnalysisProgress(): { total: number; analyzed: number; remaining: number } {
    if (!this.db) return { total: 0, analyzed: 0, remaining: 0 };
    const row = this.db
      .query<{ total: number; analyzed: number }, []>(
        `SELECT COUNT(*) as total, SUM(CASE WHEN analyzed = 1 THEN 1 ELSE 0 END) as analyzed FROM wechat_oa_articles`,
      )
      .get();
    const total = row?.total ?? 0;
    const analyzed = row?.analyzed ?? 0;
    return { total, analyzed, remaining: total - analyzed };
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
  // Startup cleanup — purge blacklisted / empty-name articles
  // ──────────────────────────────────────────────────

  /**
   * Delete articles and their insights for accounts that are blacklisted or have empty names.
   * Called once at startup so that manual blacklist updates retroactively clean up historical data.
   * Returns the number of articles deleted.
   */
  purgeBlacklistedArticles(blacklist: Set<string>): number {
    if (!this.db || blacklist.size === 0) return 0;

    // Find articles matching blacklisted accounts OR empty accountNick
    const placeholders = Array.from(blacklist).map(() => '?').join(', ');
    const matchedArticles = this.db
      .query<{ msgId: string; accountNick: string }, string[]>(
        `SELECT msgId, accountNick FROM wechat_oa_articles
         WHERE accountNick IN (${placeholders}) OR accountNick = ''`,
      )
      .all(...Array.from(blacklist));

    if (matchedArticles.length === 0) return 0;

    const msgIds = matchedArticles.map((a) => a.msgId);
    const idPlaceholders = msgIds.map(() => '?').join(', ');

    // Delete insights first (FK-like relationship on articleMsgId)
    const insightsResult = this.db
      .query(`DELETE FROM wechat_article_insights WHERE articleMsgId IN (${idPlaceholders})`)
      .run(...msgIds);

    // Delete the articles themselves
    const articlesResult = this.db
      .query(`DELETE FROM wechat_oa_articles WHERE msgId IN (${idPlaceholders})`)
      .run(...msgIds);

    const deletedArticles = articlesResult.changes;
    const deletedInsights = insightsResult.changes;

    if (deletedArticles > 0 || deletedInsights > 0) {
      // Group by account for logging
      const byAccount = new Map<string, number>();
      for (const a of matchedArticles) {
        const key = a.accountNick || '(empty name)';
        byAccount.set(key, (byAccount.get(key) ?? 0) + 1);
      }
      const breakdown = Array.from(byAccount.entries())
        .map(([nick, count]) => `${nick}(${count})`)
        .join(', ');
      logger.info(
        `[WeChatDatabase] Purged ${deletedArticles} blacklisted/empty-name articles, ` +
          `${deletedInsights} insights | ${breakdown}`,
      );
    }

    return deletedArticles;
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
          (articleMsgId, title, url, source, headline, categoryTags, items, worthReporting, evergreen, analyzedAt, model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.articleMsgId,
          row.title,
          row.url,
          row.source,
          row.headline,
          row.categoryTags,
          row.items,
          row.worthReporting,
          row.evergreen ?? 0,
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

  /** Get a single article insight by articleMsgId. */
  getArticleInsightById(articleMsgId: string): WeChatArticleInsightRow | null {
    if (!this.db) return null;
    return (
      this.db
        .query<WeChatArticleInsightRow, [string]>(`SELECT * FROM wechat_article_insights WHERE articleMsgId = ?`)
        .get(articleMsgId) ?? null
    );
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
  // Cleanup — expired article data
  // ──────────────────────────────────────────────────

  /**
   * Get article msgIds that are expired and eligible for RAG cleanup.
   * An article is expired if:
   *   - It was received before `beforeTs` (unix seconds), AND
   *   - It is NOT marked as evergreen in article_insights (evergreen=0 or no insight row)
   * @returns Array of msgIds to clean up from RAG
   */
  getExpiredArticleMsgIds(beforeTs: number): string[] {
    if (!this.db) return [];
    return this.db
      .query<{ msgId: string }, [number]>(
        `SELECT a.msgId FROM wechat_oa_articles a
         LEFT JOIN wechat_article_insights i ON a.msgId = i.articleMsgId
         WHERE a.pubTime > 0 AND a.pubTime < ?
           AND (i.evergreen IS NULL OR i.evergreen = 0)`,
      )
      .all(beforeTs)
      .map((r) => r.msgId);
  }

  /**
   * Delete article rows by msgIds. Used after RAG cleanup to remove expired articles.
   * @returns Number of rows deleted
   */
  deleteArticlesByMsgIds(msgIds: string[]): number {
    if (!this.db || msgIds.length === 0) return 0;
    let deleted = 0;
    const stmtArticles = this.db.query<void, [string]>(`DELETE FROM wechat_oa_articles WHERE msgId = ?`);
    const stmtInsights = this.db.query<void, [string]>(`DELETE FROM wechat_article_insights WHERE articleMsgId = ?`);
    for (const msgId of msgIds) {
      stmtArticles.run(msgId);
      stmtInsights.run(msgId);
      deleted++;
    }
    return deleted;
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
    // Migrate: add accountCategory column for account-level classification
    try {
      this.db.run(`ALTER TABLE wechat_oa_articles ADD COLUMN accountCategory TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_oa_accountCategory ON wechat_oa_articles(accountCategory)`);

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
        evergreen       INTEGER NOT NULL DEFAULT 0,
        analyzedAt      TEXT    NOT NULL DEFAULT '',
        model           TEXT    NOT NULL DEFAULT ''
      )
    `);
    // Migrate: add evergreen column for existing DBs
    try {
      this.db.run(`ALTER TABLE wechat_article_insights ADD COLUMN evergreen INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_analyzedAt      ON wechat_article_insights(analyzedAt)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_worthReporting   ON wechat_article_insights(worthReporting)`);

    // Moments ingest sync state
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_moments_sync (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        syncedAt        TEXT    NOT NULL DEFAULT '',
        newestTimestamp INTEGER NOT NULL DEFAULT 0,
        oldestTimestamp INTEGER NOT NULL DEFAULT 0,
        fetched         INTEGER NOT NULL DEFAULT 0,
        ingested        INTEGER NOT NULL DEFAULT 0,
        skippedEmpty    INTEGER NOT NULL DEFAULT 0,
        imagesDownloaded INTEGER NOT NULL DEFAULT 0,
        imagesFailed    INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Moments sentiment analysis results
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_moments_sentiment (
        moment_id     TEXT PRIMARY KEY,
        sentiment     TEXT    NOT NULL,
        score         REAL    NOT NULL,
        attitude_tags TEXT    NOT NULL DEFAULT '[]',
        create_time   TEXT    NOT NULL DEFAULT '',
        analyzed_at   TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ms_sentiment   ON wechat_moments_sentiment(sentiment)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ms_create_time ON wechat_moments_sentiment(create_time)`);

    // Moments entity extraction results
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_moments_entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        moment_id   TEXT    NOT NULL,
        entity_name TEXT    NOT NULL,
        entity_type TEXT    NOT NULL,
        create_time TEXT    NOT NULL DEFAULT '',
        UNIQUE(moment_id, entity_name, entity_type)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_me_entity_name ON wechat_moments_entities(entity_name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_me_entity_type ON wechat_moments_entities(entity_type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_me_moment_id   ON wechat_moments_entities(moment_id)`);

    // Moments cluster assignment results
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_moments_clusters (
        moment_id     TEXT PRIMARY KEY,
        cluster_id    INTEGER NOT NULL,
        cluster_label TEXT    NOT NULL DEFAULT '',
        clustered_at  TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mc_cluster_id ON wechat_moments_clusters(cluster_id)`);

    logger.debug('[WeChatDatabase] Schema ready');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Moments sync state
  // ──────────────────────────────────────────────────────────────────────────

  /** Get the newest moment timestamp (unix seconds) from the last successful sync. Returns 0 if never synced. */
  getMomentsLastSyncTimestamp(): number {
    if (!this.db) return 0;
    const row = this.db
      .query<{ newestTimestamp: number }, []>(
        `SELECT newestTimestamp FROM wechat_moments_sync ORDER BY id DESC LIMIT 1`,
      )
      .get();
    return row?.newestTimestamp ?? 0;
  }

  /** Record a completed moments sync. */
  recordMomentsSync(result: {
    newestTimestamp: number;
    oldestTimestamp: number;
    fetched: number;
    ingested: number;
    skippedEmpty: number;
    imagesDownloaded: number;
    imagesFailed: number;
  }): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO wechat_moments_sync (syncedAt, newestTimestamp, oldestTimestamp, fetched, ingested, skippedEmpty, imagesDownloaded, imagesFailed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        result.newestTimestamp,
        result.oldestTimestamp,
        result.fetched,
        result.ingested,
        result.skippedEmpty,
        result.imagesDownloaded,
        result.imagesFailed,
      ],
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Moments sentiment analysis
  // ──────────────────────────────────────────────────────────────────────────

  /** Upsert sentiment analysis result for a moment. */
  upsertMomentSentiment(row: {
    momentId: string;
    sentiment: string;
    score: number;
    attitudeTags: string[];
    createTime: string;
  }): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO wechat_moments_sentiment (moment_id, sentiment, score, attitude_tags, create_time, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(moment_id) DO UPDATE SET sentiment=excluded.sentiment, score=excluded.score, attitude_tags=excluded.attitude_tags, analyzed_at=excluded.analyzed_at`,
      [
        row.momentId,
        row.sentiment,
        row.score,
        JSON.stringify(row.attitudeTags),
        row.createTime,
        new Date().toISOString(),
      ],
    );
  }

  /** Get sentiment trend grouped by month. */
  getMomentsSentimentTrend(): Array<{
    month: string;
    avgScore: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    count: number;
  }> {
    if (!this.db) return [];
    return this.db
      .query<
        {
          month: string;
          avgScore: number;
          positive: number;
          negative: number;
          neutral: number;
          mixed: number;
          count: number;
        },
        []
      >(
        `SELECT
          substr(create_time, 1, 7) AS month,
          AVG(score) AS avgScore,
          SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) AS positive,
          SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) AS negative,
          SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) AS neutral,
          SUM(CASE WHEN sentiment='mixed' THEN 1 ELSE 0 END) AS mixed,
          COUNT(*) AS count
        FROM wechat_moments_sentiment
        WHERE create_time != ''
        GROUP BY month
        ORDER BY month`,
      )
      .all();
  }

  /** Get overall sentiment distribution. */
  getMomentsSentimentOverall(): {
    avgScore: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    total: number;
  } {
    if (!this.db) return { avgScore: 0, positive: 0, negative: 0, neutral: 0, mixed: 0, total: 0 };
    const row = this.db
      .query<
        { avgScore: number; positive: number; negative: number; neutral: number; mixed: number; total: number },
        []
      >(
        `SELECT
          COALESCE(AVG(score), 0) AS avgScore,
          SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) AS positive,
          SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) AS negative,
          SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) AS neutral,
          SUM(CASE WHEN sentiment='mixed' THEN 1 ELSE 0 END) AS mixed,
          COUNT(*) AS total
        FROM wechat_moments_sentiment`,
      )
      .get();
    return row ?? { avgScore: 0, positive: 0, negative: 0, neutral: 0, mixed: 0, total: 0 };
  }

  /** Get all moment IDs that have been sentiment-analyzed. */
  getAnalyzedSentimentIds(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db.query<{ id: string }, []>(`SELECT moment_id AS id FROM wechat_moments_sentiment`).all();
    return new Set(rows.map((r) => r.id));
  }

  /** Get all moment IDs that have been entity-extracted. */
  getAnalyzedEntityIds(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db
      .query<{ id: string }, []>(`SELECT DISTINCT moment_id AS id FROM wechat_moments_entities`)
      .all();
    return new Set(rows.map((r) => r.id));
  }

  /** Count moments that have been sentiment-analyzed. */
  getMomentsSentimentCount(): number {
    if (!this.db) return 0;
    const row = this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM wechat_moments_sentiment`).get();
    return row?.count ?? 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Moments entity extraction
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Upsert extracted entities for a moment. Deletes old entities first.
   * If entities is empty, inserts a placeholder (_none_) so the moment
   * is still marked as analyzed and won't be re-processed.
   */
  upsertMomentEntities(momentId: string, createTime: string, entities: Array<{ name: string; type: string }>): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM wechat_moments_entities WHERE moment_id = ?`, [momentId]);
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO wechat_moments_entities (moment_id, entity_name, entity_type, create_time) VALUES (?, ?, ?, ?)`,
    );
    if (entities.length === 0) {
      stmt.run(momentId, '_none_', '_none_', createTime);
    } else {
      for (const e of entities) {
        stmt.run(momentId, e.name, e.type, createTime);
      }
    }
  }

  /** Get top entities by frequency, optionally filtered by type. */
  getMomentsTopEntities(opts?: {
    type?: string;
    limit?: number;
  }): Array<{ name: string; type: string; count: number }> {
    if (!this.db) return [];
    const limit = opts?.limit ?? 50;
    if (opts?.type) {
      return this.db
        .query<{ name: string; type: string; count: number }, [string, number]>(
          `SELECT entity_name AS name, entity_type AS type, COUNT(*) AS count
           FROM wechat_moments_entities
           WHERE entity_type = ? AND entity_name != '_none_'
           GROUP BY entity_name, entity_type
           ORDER BY count DESC
           LIMIT ?`,
        )
        .all(opts.type, limit);
    }
    return this.db
      .query<{ name: string; type: string; count: number }, [number]>(
        `SELECT entity_name AS name, entity_type AS type, COUNT(*) AS count
         FROM wechat_moments_entities
         WHERE entity_name != '_none_'
         GROUP BY entity_name, entity_type
         ORDER BY count DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  /** Get entities grouped by type with counts. */
  getMomentsEntitiesByType(): Record<string, Array<{ name: string; count: number }>> {
    if (!this.db) return {};
    const rows = this.db
      .query<{ name: string; type: string; count: number }, []>(
        `SELECT entity_name AS name, entity_type AS type, COUNT(*) AS count
         FROM wechat_moments_entities
         WHERE entity_name != '_none_'
         GROUP BY entity_name, entity_type
         ORDER BY count DESC`,
      )
      .all();
    const result: Record<string, Array<{ name: string; count: number }>> = {};
    for (const r of rows) {
      if (!result[r.type]) result[r.type] = [];
      result[r.type].push({ name: r.name, count: r.count });
    }
    return result;
  }

  /** Count moments that have been entity-extracted. */
  getMomentsEntityMomentCount(): number {
    if (!this.db) return 0;
    const row = this.db
      .query<{ count: number }, []>(`SELECT COUNT(DISTINCT moment_id) as count FROM wechat_moments_entities`)
      .get();
    return row?.count ?? 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Moments clustering
  // ──────────────────────────────────────────────────────────────────────────

  /** Get all clusters with their labels and counts. */
  getMomentsClusters(): Array<{ clusterId: number; label: string; count: number }> {
    if (!this.db) return [];
    return this.db
      .query<{ clusterId: number; label: string; count: number }, []>(
        `SELECT cluster_id AS clusterId, cluster_label AS label, COUNT(*) AS count
         FROM wechat_moments_clusters
         GROUP BY cluster_id, cluster_label
         ORDER BY count DESC`,
      )
      .all();
  }

  /** Get moment IDs belonging to a specific cluster. */
  getMomentsClusterMembers(clusterId: number, limit = 20): Array<{ momentId: string }> {
    if (!this.db) return [];
    return this.db
      .query<{ momentId: string }, [number, number]>(
        `SELECT moment_id AS momentId FROM wechat_moments_clusters WHERE cluster_id = ? LIMIT ?`,
      )
      .all(clusterId, limit);
  }

  /** Count moments that have been clustered. */
  getMomentsClusteredCount(): number {
    if (!this.db) return 0;
    const row = this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM wechat_moments_clusters`).get();
    return row?.count ?? 0;
  }
}
