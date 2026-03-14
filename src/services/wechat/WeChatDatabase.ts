// Standalone SQLite persistence for WeChat messages
// Writes to data/wechat.db — completely independent of the core DatabaseManager

import { Database } from 'bun:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Row type (maps directly to table columns)
// ────────────────────────────────────────────────────────────────────────────

export interface WeChatMessageRow {
  id?: number;            // auto-increment primary key
  newMsgId: string;       // WeChatPadPro NewMsgId (unique)
  conversationId: string; // group chatroom-ID or private wxid
  isGroup: number;        // 1 = group, 0 = private
  sender: string;         // sender nickname or wxid
  content: string;        // parsed plain text
  rawContent: string;     // original Content field (may be XML)
  msgType: number;        // WeChatPadPro MsgType
  category: string;       // text | image | article | file | system | other
  createTime: number;     // unix seconds (from webhook CreateTime)
  receivedAt: string;     // ISO timestamp when bot received the message
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
  // Write
  // ──────────────────────────────────────────────────

  /** Insert a message. Silently ignores duplicates (ON CONFLICT IGNORE). */
  insert(row: Omit<WeChatMessageRow, 'id'>): void {
    if (!this.db) { logger.warn('[WeChatDatabase] insert called before init'); return; }
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
  // Read
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
      .query<
        { conversationId: string; isGroup: number; count: number; lastTime: number },
        []
      >(
        `SELECT conversationId, isGroup, COUNT(*) as count, MAX(createTime) as lastTime
         FROM wechat_messages
         GROUP BY conversationId
         ORDER BY lastTime DESC`,
      )
      .all();
  }

  // ──────────────────────────────────────────────────
  // Schema
  // ──────────────────────────────────────────────────

  private migrate(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wechat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        newMsgId    TEXT    NOT NULL UNIQUE,
        conversationId TEXT NOT NULL,
        isGroup     INTEGER NOT NULL DEFAULT 0,
        sender      TEXT    NOT NULL DEFAULT '',
        content     TEXT    NOT NULL DEFAULT '',
        rawContent  TEXT    NOT NULL DEFAULT '',
        msgType     INTEGER NOT NULL DEFAULT 1,
        category    TEXT    NOT NULL DEFAULT 'other',
        createTime  INTEGER NOT NULL DEFAULT 0,
        receivedAt  TEXT    NOT NULL DEFAULT ''
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_conversation ON wechat_messages(conversationId)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_createTime   ON wechat_messages(createTime)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wm_category     ON wechat_messages(category)`);
    logger.debug('[WeChatDatabase] Schema ready');
  }
}
