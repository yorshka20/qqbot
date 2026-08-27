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
// ## Retention
//
// The table is a ledger: nothing here deletes a row. Expiry, the per-session cap
// and an explicit retire all mark an item as no longer live by stamping
// `expires_at`, and reads filter on that. The written record of what the bot once
// noted therefore survives, while only live items reach the prompt.

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

/** Live = still reaching the prompt: pinned, or not yet past its expiry. */
function isLive(item: SessionMemoItem, now: number): boolean {
  return item.expiresAt === null || item.expiresAt > now;
}

/** In-memory counterpart of the retiring UPDATE — keeps `pinned XOR expiresAt` intact. */
function retireItem(item: SessionMemoItem, now: number): void {
  item.pinned = false;
  item.expiresAt = now;
  item.updatedAt = now;
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
      this.db
        .query(
          'INSERT INTO session_memos (id, session_id, content, pinned, expires_at, created_at, updated_at, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(item.id, sessionId, content, pinned ? 1 : 0, expiresAt, now, now, JSON.stringify(tags));
      this.enforceSqliteCapForSession(this.db, sessionId, now);
    } else {
      const list = this.memStore.get(sessionId) ?? [];
      list.push(item);
      this.memStore.set(sessionId, list);
      this.enforceMemoryCapForSession(sessionId, now);
    }

    return item;
  }

  /**
   * Take one item out of the live set. The row stays; a pinned item loses its pin
   * so that the `pinned XOR expiresAt` invariant still holds. Returns false when
   * the id is unknown or already retired.
   */
  retire(sessionId: string, id: string, now: number = Date.now()): boolean {
    if (this.db !== null) {
      const result = this.db
        .query(
          'UPDATE session_memos SET pinned = 0, expires_at = ?, updated_at = ? WHERE session_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)',
        )
        .run(now, now, sessionId, id, now) as { changes: number };
      return result.changes > 0;
    } else {
      const item = this.memStore.get(sessionId)?.find((candidate) => candidate.id === id);
      if (!item || !isLive(item, now)) return false;
      retireItem(item, now);
      return true;
    }
  }

  /** Live items only, oldest first. Retired and expired items stay in the store, unread. */
  list(sessionId: string, now: number = Date.now()): SessionMemoItem[] {
    if (this.db !== null) {
      return this.liveRows(this.db, sessionId, now).map(rowToItem);
    } else {
      return (this.memStore.get(sessionId) ?? []).filter((item) => isLive(item, now));
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

  /** Retire every live item of a session at once. */
  retireAll(sessionId: string, now: number = Date.now()): void {
    if (this.db !== null) {
      this.db
        .query(
          'UPDATE session_memos SET pinned = 0, expires_at = ?, updated_at = ? WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)',
        )
        .run(now, now, sessionId, now);
    } else {
      for (const item of this.memStore.get(sessionId) ?? []) {
        if (isLive(item, now)) retireItem(item, now);
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private liveRows(db: Database, sessionId: string, now: number): MemoRow[] {
    return db
      .query<MemoRow, [string, number]>(
        'SELECT * FROM session_memos WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC',
      )
      .all(sessionId, now);
  }

  private enforceSqliteCapForSession(db: Database, sessionId: string, now: number): void {
    const rows = this.liveRows(db, sessionId, now);
    const overflow = rows.length - this.maxItemsPerSession;
    if (overflow <= 0) return;

    for (const row of rows.filter((r) => r.pinned === 0).slice(0, overflow)) {
      db.query('UPDATE session_memos SET expires_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
    }
  }

  private enforceMemoryCapForSession(sessionId: string, now: number): void {
    const live = (this.memStore.get(sessionId) ?? []).filter((item) => isLive(item, now));
    const overflow = live.length - this.maxItemsPerSession;
    if (overflow <= 0) return;

    for (const item of live.filter((candidate) => !candidate.pinned).slice(0, overflow)) {
      retireItem(item, now);
    }
  }
}
