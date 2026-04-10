// Persistence helper for LAN client internal reports.
//
// Phase 2 — F1 decision: reports go into the host's existing sqlite database
// in a dedicated table `lan_internal_reports`. The table is created by
// SQLiteAdapter migration so this helper just runs raw queries against the
// rawDb handle (passed in by LanRelayHost at construction time).
//
// Use:
//   const store = new LanInternalReportStore(rawDb);
//   store.insert({ clientId, level, text, ts });
//   store.query(clientId, { limit: 50 });
//
// Querying is done via /lan log <clientId> [n].

import type { Database } from 'bun:sqlite';
import type { LanRelayInternalReportPayload } from '../types/wire';

export interface LanInternalReportRow {
  id: number;
  clientId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
  ts: number;
}

/** Defaults / hard limits for /lan log per F2 decision. */
export const LAN_REPORT_DEFAULT_LIMIT = 20;
export const LAN_REPORT_MAX_LIMIT = 200;

export class LanInternalReportStore {
  constructor(private readonly db: Database) {}

  /** Insert a single report row. Best-effort: caller does not await persistence. */
  insert(payload: LanRelayInternalReportPayload): void {
    try {
      const stmt = this.db.query(`INSERT INTO lan_internal_reports (clientId, level, text, ts) VALUES (?, ?, ?, ?)`);
      stmt.run(payload.clientId, payload.level, payload.text, payload.ts);
    } catch (err) {
      // Don't throw — internal reports are best-effort. Caller already has a
      // logger fallback in handleHostClientMessage.
      // eslint-disable-next-line no-console
      console.warn('[LanInternalReportStore] insert failed:', err);
    }
  }

  /**
   * Query the most recent N reports for a client (newest first).
   * `limit` is clamped to [1, LAN_REPORT_MAX_LIMIT].
   */
  query(
    clientId: string,
    opts?: { limit?: number; level?: 'debug' | 'info' | 'warn' | 'error' },
  ): LanInternalReportRow[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? LAN_REPORT_DEFAULT_LIMIT, LAN_REPORT_MAX_LIMIT));
    let sql = `SELECT id, clientId, level, text, ts FROM lan_internal_reports WHERE clientId = ?`;
    const params: (string | number)[] = [clientId];
    if (opts?.level) {
      sql += ` AND level = ?`;
      params.push(opts.level);
    }
    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.query(sql);
    return stmt.all(...params) as LanInternalReportRow[];
  }
}
