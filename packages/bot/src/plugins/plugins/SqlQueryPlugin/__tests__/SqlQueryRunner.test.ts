import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlQueryRunner } from '../SqlQueryRunner';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sql-query-runner-'));
  dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, blob BLOB)');
  db.run("INSERT INTO notes (body, blob) VALUES ('alpha', x'0102'), ('beta', NULL), ('gamma', NULL)");
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SqlQueryRunner', () => {
  it('returns rows and column names for a read query', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run('SELECT id, body FROM notes ORDER BY id', 10);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.columns).toEqual(['id', 'body']);
    expect(outcome.rows).toEqual([
      { id: 1, body: 'alpha' },
      { id: 2, body: 'beta' },
      { id: 3, body: 'gamma' },
    ]);
    expect(outcome.truncated).toBe(false);
  });

  it('stops at the row cap and reports truncation', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run('SELECT id FROM notes ORDER BY id', 2);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
  });

  it('renders blobs as a placeholder instead of a byte map', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run('SELECT blob FROM notes WHERE id = 1', 10);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows[0].blob).toBe('<blob 2B>');
  });

  it('reports column names even when nothing matches', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run("SELECT id, body FROM notes WHERE body = 'nope'", 10);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toEqual([]);
    expect(outcome.columns).toEqual(['id', 'body']);
  });

  it('refuses writes at the SQLite level, not by inspecting the text', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run("INSERT INTO notes (body) VALUES ('written')", 10);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('readonly');

    const db = new Database(dbPath, { readonly: true });
    expect(db.query('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 3 });
    db.close();
  });

  it('surfaces SQL errors instead of throwing', async () => {
    const runner = new SqlQueryRunner(dbPath, 10_000);
    const outcome = await runner.run('SELECT * FROM missing_table', 10);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('missing_table');
  });

  it('kills a query that outruns the timeout', async () => {
    const runner = new SqlQueryRunner(dbPath, 1_000);
    const outcome = await runner.run(
      'WITH RECURSIVE forever(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM forever) SELECT count(*) FROM forever',
      10,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('未完成');
  }, 15_000);
});
