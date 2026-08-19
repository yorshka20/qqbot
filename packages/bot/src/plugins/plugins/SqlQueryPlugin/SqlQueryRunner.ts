// Executes one read-only SQL statement per throwaway `bun -e` child process.
//
// bun:sqlite steps statements synchronously and exposes neither sqlite3_interrupt
// nor a progress handler, so a statement run on the main thread holds the event
// loop until SQLite is done — an unindexed scan or a self-join written by the LLM
// would freeze protocol heartbeats with no way to cancel. In a child process the
// cancellation primitive is SIGKILL, which the OS honours no matter where SQLite
// is inside its own C code. Startup costs ~15ms, which is noise next to any query
// worth running.
//
// The child opens the database with SQLITE_OPEN_READONLY: writes are refused by
// SQLite itself rather than by inspecting the statement text.

import { logger } from '@/utils/logger';
import type { SqlQueryOutcome } from './types';

const RUNNER_SOURCE = `
const input = await Bun.stdin.json();
const { Database } = await import("bun:sqlite");

function encodeValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return "<blob " + value.byteLength + "B>";
  return value;
}

let db = null;
try {
  db = new Database(input.dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");

  const startedAt = Bun.nanoseconds();
  const statement = db.query(input.sql);
  const rows = [];
  let truncated = false;

  for (const row of statement.iterate()) {
    if (rows.length >= input.maxRows) {
      truncated = true;
      break;
    }
    const encoded = {};
    for (const key of Object.keys(row)) encoded[key] = encodeValue(row[key]);
    rows.push(encoded);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    columns: statement.columnNames,
    rows: rows,
    truncated: truncated,
    elapsedMs: Math.round((Bun.nanoseconds() - startedAt) / 1e6),
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error && error.message ? error.message : String(error),
  }));
} finally {
  if (db) db.close();
}
`;

export class SqlQueryRunner {
  constructor(
    private readonly dbPath: string,
    private readonly timeoutMs: number,
  ) {}

  async run(sql: string, maxRows: number): Promise<SqlQueryOutcome> {
    const proc = Bun.spawn([process.execPath, '-e', RUNNER_SOURCE], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    proc.stdin.write(JSON.stringify({ dbPath: this.dbPath, sql, maxRows }));
    await proc.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, this.timeoutMs);

    let stdout = '';
    let stderr = '';
    try {
      [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      logger.warn(`[SqlQueryRunner] Killed query after ${this.timeoutMs}ms: ${sql.slice(0, 200)}`);
      return { ok: false, error: `查询超过 ${this.timeoutMs}ms 未完成，已终止。请收窄 WHERE 条件或减少扫描的表。` };
    }

    if (!stdout) {
      const detail = stderr.trim().slice(0, 400);
      logger.error(`[SqlQueryRunner] Child produced no output. stderr: ${detail}`);
      return { ok: false, error: `查询进程没有返回结果${detail ? `：${detail}` : ''}` };
    }

    try {
      return JSON.parse(stdout) as SqlQueryOutcome;
    } catch {
      return { ok: false, error: `查询进程输出无法解析：${stdout.slice(0, 400)}` };
    }
  }
}
