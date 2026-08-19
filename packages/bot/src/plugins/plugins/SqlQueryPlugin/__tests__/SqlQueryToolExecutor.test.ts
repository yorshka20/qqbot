import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from '@/tools/types';
import { SqlQueryRunner } from '../SqlQueryRunner';
import { SqlQueryToolExecutor } from '../SqlQueryToolExecutor';

let dir: string;
let executor: SqlQueryToolExecutor;

function call(parameters: Record<string, unknown>): ToolCall {
  return { type: 'query_database', executor: 'query_database', parameters };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sql-query-tool-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.run('CREATE TABLE speakers (userId TEXT, groupId TEXT, content TEXT)');
  db.run('CREATE INDEX idx_speakers_group ON speakers(groupId)');
  db.run(
    "INSERT INTO speakers VALUES ('a', 'g1', 'hi'), ('a', 'g1', 'again'), ('b', 'g1', 'yo'), ('c', 'g2', 'elsewhere')",
  );
  db.close();

  executor = new SqlQueryToolExecutor(new SqlQueryRunner(dbPath, 10_000), {
    defaultRows: 50,
    maxRows: 100,
    maxOutputChars: 6_000,
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SqlQueryToolExecutor', () => {
  it('runs an aggregate query and renders a table', async () => {
    const result = await executor.execute(
      call({ action: 'query', sql: 'SELECT userId, count(*) n FROM speakers GROUP BY userId ORDER BY n DESC, userId' }),
    );

    expect(result.success).toBe(true);
    expect(result.reply).toContain('userId | n');
    expect(result.reply).toContain('a | 2');
  });

  it('reports the row cap when the limit truncates the result', async () => {
    const result = await executor.execute(call({ action: 'query', sql: 'SELECT * FROM speakers', limit: 2 }));

    expect(result.success).toBe(true);
    expect(result.reply).toContain('limit=2');
  });

  it('clamps limit to the configured ceiling', async () => {
    const result = await executor.execute(call({ action: 'query', sql: 'SELECT * FROM speakers', limit: 100_000 }));

    expect(result.success).toBe(true);
    expect(result.reply).not.toContain('limit=100000');
  });

  it('rejects a write before it reaches the database', async () => {
    const result = await executor.execute(call({ action: 'query', sql: 'DELETE FROM speakers' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid sql');
  });

  it('lists every table with its columns and row count when no table is named', async () => {
    const result = await executor.execute(call({ action: 'describe' }));

    expect(result.success).toBe(true);
    expect(result.reply).toContain('speakers（4 行）');
    expect(result.reply).toContain('userId TEXT');
  });

  it('returns DDL and indexes for a named table', async () => {
    const result = await executor.execute(call({ action: 'describe', tables: ['speakers'] }));

    expect(result.success).toBe(true);
    expect(result.reply).toContain('CREATE TABLE speakers');
    expect(result.reply).toContain('idx_speakers_group');
  });

  it('rejects table names that are not plain identifiers', async () => {
    const result = await executor.execute(call({ action: 'describe', tables: ["speakers'; --"] }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid table name');
  });

  it('rejects an unknown action', async () => {
    const result = await executor.execute(call({ action: 'insert' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid action');
  });
});
