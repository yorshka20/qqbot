import { describe, expect, it } from 'bun:test';
import { AuditEventStore } from '../AuditEventStore';

const T0 = 1_800_000_000_000; // fixed base clock for deterministic tests

describe('AuditEventStore', () => {
  it('records and returns events oldest-first', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 10, maxAgeMs: 60_000 });
    store.record('group:1', { ts: T0, kind: 'reply', summary: 'a' });
    store.record('group:1', { ts: T0 + 1000, kind: 'silence', summary: 'b' });
    const got = store.getRecent('group:1', T0 + 2000);
    expect(got.map((e) => e.summary)).toEqual(['a', 'b']);
  });

  it('keeps only the newest maxItemsPerSession', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 2, maxAgeMs: 60_000 });
    store.record('g', { ts: T0, kind: 'reply', summary: '1' });
    store.record('g', { ts: T0 + 1, kind: 'reply', summary: '2' });
    store.record('g', { ts: T0 + 2, kind: 'reply', summary: '3' });
    expect(store.getRecent('g', T0 + 3).map((e) => e.summary)).toEqual(['2', '3']);
  });

  it('prunes events older than maxAgeMs', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 10, maxAgeMs: 5_000 });
    store.record('g', { ts: T0, kind: 'reply', summary: 'old' });
    store.record('g', { ts: T0 + 6_000, kind: 'reply', summary: 'fresh' });
    // Query at T0+6000: 'old' is 6s back, beyond the 5s window → dropped.
    expect(store.getRecent('g', T0 + 6_000).map((e) => e.summary)).toEqual(['fresh']);
  });

  it('isolates sessions', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 10, maxAgeMs: 60_000 });
    store.record('a', { ts: T0, kind: 'reply', summary: 'in-a' });
    expect(store.getRecent('b', T0 + 1).length).toBe(0);
  });

  it('render produces HH:MM lines and empty string when nothing to show', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 10, maxAgeMs: 60_000 });
    expect(store.render('g', T0)).toBe('');
    store.record('g', { ts: T0, kind: 'reply', summary: '回复了 张三' });
    const rendered = store.render('g', T0 + 1000);
    expect(rendered).toMatch(/^- \d{2}:\d{2} 回复了 张三$/);
  });

  it('ignores empty sessionId on record', () => {
    const store = new AuditEventStore({ maxItemsPerSession: 10, maxAgeMs: 60_000 });
    store.record('', { ts: T0, kind: 'reply', summary: 'x' });
    expect(store.getRecent('', T0 + 1).length).toBe(0);
  });
});
