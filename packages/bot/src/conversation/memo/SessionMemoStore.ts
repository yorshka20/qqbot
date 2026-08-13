// SessionMemoStore — LLM-writable per-session memo blackboard with TTL and pinning.
//
// ## How it differs from the sibling pieces
//
// | Piece              | Who writes        | Scope          | Lifetime          | Purpose                                    |
// |--------------------|-------------------|----------------|-------------------|--------------------------------------------|
// | AuditEventStore    | Bot auto-hook     | Per-session    | ~45 min in-mem    | Factual "what I just did" ledger           |
// | MemoryService      | LLM (extract)     | Per group/user | Long-term (file)  | Who the user IS / their preferences / rules|
// | SessionMemoStore   | LLM (tool)        | Per-session    | TTL + pinnable    | Short-to-medium-term notes bot wants across turns/sessions |
//
// The LLM writes memos here via the `session_memo` tool (Task 2). Examples:
// "I told this group my stance on X yesterday", "group admin prefers terse replies until further notice".
//
// ## Persistence contract
//
// Constructor with `rawDb === null` → pure in-memory Map (used when SQLite is
// unavailable, e.g. MongoDB backend). Constructor with `rawDb !== null` →
// initialises the schema immediately and uses prepared statements for CRUD.
// Both modes expose an identical public API.
//
// ## Invariant
//
// Every item satisfies: pinned XOR (expiresAt !== null).
// Pinned items live indefinitely (expiresAt = null). Non-pinned items MUST
// carry a positive TTL; add() rejects requests that violate this.
//
// ## Pruning
//
// Expired items are pruned lazily on every read/write path — no background
// cron. In SQLite mode a single DELETE runs before each read or write.

import type { Database } from 'bun:sqlite';
import { randomUUID } from '@/utils/randomUUID';

export interface SessionMemoItem {
  id: string;
  sessionId: string;
  content: string;
  pinned: boolean;
  /** ms epoch; null iff pinned, positive number iff !pinned */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

export interface SessionMemoStoreOptions {
  maxItemsPerSession?: number;
}

interface MemoRow {
  id: string;
  session_id: string;
  content: string;
  pinned: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  tags_json: string;
}

function rowToItem(row: MemoRow): SessionMemoItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    pinned: row.pinned === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags_json) as string[],
  };
}

/** Local MM-DD HH:MM formatter for render output. */
function formatExpiry(ts: number): string {
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function generateId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

const DEFAULT_MAX_ITEMS = 20;

export class SessionMemoStore {
  private readonly db: Database | null;
  private readonly maxItemsPerSession: number;
  /** In-memory fallback used when db === null */
  private readonly memStore = new Map<string, SessionMemoItem[]>();

  constructor(rawDb: Database | null, options?: SessionMemoStoreOptions) {
    this.db = rawDb;
    this.maxItemsPerSession = options?.maxItemsPerSession ?? DEFAULT_MAX_ITEMS;

    if (rawDb !== null) {
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS session_memos (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_session_memos_session ON session_memos(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_memos_expires ON session_memos(expires_at);
      `);
    }
  }

  add(
    sessionId: string,
    input: {
      content: string;
      pinned?: boolean;
      ttlMs?: number;
      tags?: string[];
    },
  ): SessionMemoItem {
    const now = Date.now();
    const { content, pinned = false, ttlMs, tags = [] } = input;

    if (!content || typeof content !== 'string' || content.trim() === '') {
      throw new Error('content must be a non-empty string');
    }

    let expiresAt: number | null;
    if (pinned) {
      expiresAt = null;
    } else {
      if (ttlMs == null || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error('non-pinned memo requires ttlMs > 0');
      }
      expiresAt = now + ttlMs;
    }

    const item: SessionMemoItem = {
      id: generateId(),
      sessionId,
      content,
      pinned,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      tags,
    };

    if (this.db !== null) {
      this.pruneExpiredSqlite(this.db, sessionId, now);
      this.db
        .query(
          'INSERT INTO session_memos (id, session_id, content, pinned, expires_at, created_at, updated_at, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(item.id, sessionId, content, pinned ? 1 : 0, expiresAt, now, now, JSON.stringify(tags));
      this.enforceSqliteCapForSession(this.db, sessionId);
    } else {
      this.pruneExpiredMemory(sessionId, now);
      const list = this.memStore.get(sessionId) ?? [];
      list.push(item);
      this.memStore.set(sessionId, list);
      this.enforceMemoryCapForSession(sessionId);
    }

    return item;
  }

  delete(sessionId: string, id: string): boolean {
    if (this.db !== null) {
      const result = this.db.query('DELETE FROM session_memos WHERE session_id = ? AND id = ?').run(sessionId, id) as {
        changes: number;
      };
      return result.changes > 0;
    } else {
      const list = this.memStore.get(sessionId);
      if (!list) return false;
      const idx = list.findIndex((item) => item.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      return true;
    }
  }

  list(sessionId: string, now: number = Date.now()): SessionMemoItem[] {
    if (this.db !== null) {
      this.pruneExpiredSqlite(this.db, sessionId, now);
      const rows = this.db
        .query<MemoRow, [string]>('SELECT * FROM session_memos WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId);
      return rows.map(rowToItem);
    } else {
      this.pruneExpiredMemory(sessionId, now);
      const list = this.memStore.get(sessionId) ?? [];
      return [...list];
    }
  }

  render(sessionId: string, now: number = Date.now()): string {
    const items = this.list(sessionId, now);
    if (items.length === 0) return '';
    return items
      .map((item) => {
        const tag = item.pinned ? '[PIN]' : `[exp ${formatExpiry(item.expiresAt as number)}]`;
        return `- [id:${item.id}] ${tag} ${item.content}`;
      })
      .join('\n');
  }

  clear(sessionId: string): void {
    if (this.db !== null) {
      this.db.query('DELETE FROM session_memos WHERE session_id = ?').run(sessionId);
    } else {
      this.memStore.delete(sessionId);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private pruneExpiredSqlite(db: Database, sessionId: string, now: number): void {
    db.query('DELETE FROM session_memos WHERE session_id = ? AND expires_at IS NOT NULL AND expires_at <= ?').run(
      sessionId,
      now,
    );
  }

  private pruneExpiredMemory(sessionId: string, now: number): void {
    const list = this.memStore.get(sessionId);
    if (!list) return;
    const fresh = list.filter((item) => item.expiresAt === null || item.expiresAt > now);
    this.memStore.set(sessionId, fresh);
  }

  private enforceSqliteCapForSession(db: Database, sessionId: string): void {
    const rows = db
      .query<MemoRow, [string]>('SELECT * FROM session_memos WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId);

    const total = rows.length;
    if (total <= this.maxItemsPerSession) return;

    const overflow = total - this.maxItemsPerSession;
    const nonPinned = rows.filter((r) => r.pinned === 0);
    const toDrop = nonPinned.slice(0, overflow);
    for (const row of toDrop) {
      db.query('DELETE FROM session_memos WHERE id = ?').run(row.id);
    }
  }

  private enforceMemoryCapForSession(sessionId: string): void {
    const list = this.memStore.get(sessionId);
    if (!list) return;

    const total = list.length;
    if (total <= this.maxItemsPerSession) return;

    const overflow = total - this.maxItemsPerSession;
    let dropped = 0;
    const result: SessionMemoItem[] = [];
    for (const item of list) {
      if (!item.pinned && dropped < overflow) {
        dropped++;
        continue;
      }
      result.push(item);
    }
    this.memStore.set(sessionId, result);
  }
}
