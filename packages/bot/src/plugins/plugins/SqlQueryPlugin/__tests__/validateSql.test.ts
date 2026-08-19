import { describe, expect, it } from 'bun:test';
import { validateReadStatement } from '../validateSql';

describe('validateReadStatement', () => {
  it('accepts a plain SELECT and strips the trailing semicolon', () => {
    const result = validateReadStatement('  SELECT 1;  ');
    expect(result).toEqual({ ok: true, statement: 'SELECT 1' });
  });

  it('accepts WITH and EXPLAIN heads', () => {
    expect(validateReadStatement('WITH t AS (SELECT 1) SELECT * FROM t').ok).toBe(true);
    expect(validateReadStatement('EXPLAIN QUERY PLAN SELECT * FROM messages').ok).toBe(true);
  });

  it('accepts a leading comment before the statement', () => {
    const result = validateReadStatement('-- count them\nSELECT count(*) FROM messages');
    expect(result.ok).toBe(true);
  });

  it('rejects writes and other non-read statements', () => {
    for (const sql of [
      'DELETE FROM messages',
      'UPDATE messages SET content = 1',
      'DROP TABLE messages',
      "ATTACH DATABASE '/etc/passwd' AS x",
      'PRAGMA table_info(messages)',
    ]) {
      expect(validateReadStatement(sql).ok).toBe(false);
    }
  });

  it('rejects a second statement smuggled after the first', () => {
    const result = validateReadStatement('SELECT 1; DROP TABLE messages');
    expect(result).toEqual({ ok: false, reason: '一次只能执行一条语句，请去掉语句中间的分号' });
  });

  it('does not mistake a semicolon inside a literal for a second statement', () => {
    expect(validateReadStatement("SELECT * FROM messages WHERE content LIKE '%;%'").ok).toBe(true);
    expect(validateReadStatement("SELECT * FROM messages WHERE content = 'it''s; fine'").ok).toBe(true);
    expect(validateReadStatement('SELECT * FROM messages -- drop; everything').ok).toBe(true);
    expect(validateReadStatement('SELECT /* ; */ 1').ok).toBe(true);
  });

  it('rejects empty input', () => {
    expect(validateReadStatement('   ').ok).toBe(false);
    expect(validateReadStatement(';;').ok).toBe(false);
  });
});
