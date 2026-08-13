import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SessionMemoStore } from '../SessionMemoStore';

const T0 = 1_800_000_000_000;

const modes = [
  { label: 'in-memory', makeStore: (opts?: { maxItemsPerSession?: number }) => new SessionMemoStore(null, opts) },
  {
    label: 'sqlite',
    makeStore: (opts?: { maxItemsPerSession?: number }) => new SessionMemoStore(new Database(':memory:'), opts),
  },
];

for (const { label, makeStore } of modes) {
  describe(`SessionMemoStore [${label}]`, () => {
    it('add returns item with 8-char id and correct pinned/expiresAt semantics', () => {
      const store = makeStore();
      const item = store.add('group:1', { content: 'hello', pinned: false, ttlMs: 10_000 });
      expect(item.id).toHaveLength(8);
      expect(item.pinned).toBe(false);
      expect(typeof item.expiresAt).toBe('number');
      expect(item.expiresAt).toBeGreaterThan(0);
      expect(item.content).toBe('hello');
    });

    it('add with pinned=true sets expiresAt=null even if ttlMs was passed', () => {
      const store = makeStore();
      const item = store.add('group:1', { content: 'pinned note', pinned: true, ttlMs: 5_000 });
      expect(item.pinned).toBe(true);
      expect(item.expiresAt).toBeNull();
    });

    it('add with pinned=false and no ttlMs throws', () => {
      const store = makeStore();
      expect(() => store.add('group:1', { content: 'oops', pinned: false })).toThrow(
        'non-pinned memo requires ttlMs > 0',
      );
    });

    it('add with pinned=false and ttlMs=0 throws', () => {
      const store = makeStore();
      expect(() => store.add('group:1', { content: 'oops', pinned: false, ttlMs: 0 })).toThrow(
        'non-pinned memo requires ttlMs > 0',
      );
    });

    it('list prunes expired items', () => {
      const store = makeStore();
      const a = store.add('s', { content: 'a', pinned: false, ttlMs: 1 });
      const b = store.add('s', { content: 'b', pinned: false, ttlMs: 100_000 });
      // Before a's expiresAt — both visible.
      expect(store.list('s', a.createdAt).length).toBe(2);
      // After a's TTL — only b remains.
      const visible = store.list('s', a.expiresAt! + 1);
      expect(visible.some((i) => i.id === a.id)).toBe(false);
      expect(visible.some((i) => i.id === b.id)).toBe(true);
    });

    it('render formats pinned as [PIN] and ttl as [exp MM-DD HH:MM], oldest-first; empty -> empty string', () => {
      const store = makeStore();
      expect(store.render('group:1')).toBe('');
      store.add('group:1', { content: 'pinned note', pinned: true });
      const item2 = store.add('group:1', { content: 'ttl note', pinned: false, ttlMs: 100_000 });
      const rendered = store.render('group:1');
      const lines = rendered.split('\n');
      expect(lines.length).toBe(2);
      // Oldest (pinned) comes first.
      expect(lines[0]).toMatch(/\[id:[0-9a-f]{8}\] \[PIN\] pinned note/);
      // Second line has expiry.
      expect(lines[1]).toMatch(/\[id:[0-9a-f]{8}\] \[exp \d{2}-\d{2} \d{2}:\d{2}\] ttl note/);
      void item2;
    });

    it('session isolation: items in group:1 invisible from group:2', () => {
      const store = makeStore();
      store.add('group:1', { content: 'for group 1', pinned: true });
      expect(store.list('group:2').length).toBe(0);
    });

    it('cap evicts oldest non-pinned when maxItemsPerSession exceeded', () => {
      const store = makeStore({ maxItemsPerSession: 3 });
      const a = store.add('s', { content: 'a', pinned: false, ttlMs: 100_000 });
      const b = store.add('s', { content: 'b', pinned: false, ttlMs: 100_000 });
      const c = store.add('s', { content: 'c', pinned: false, ttlMs: 100_000 });
      const d = store.add('s', { content: 'd', pinned: false, ttlMs: 100_000 });
      const e = store.add('s', { content: 'e', pinned: false, ttlMs: 100_000 });
      const items = store.list('s');
      expect(items.length).toBe(3);
      // Oldest two (a, b) are dropped; newest three remain.
      const ids = items.map((i) => i.id);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(b.id);
      expect(ids).toContain(c.id);
      expect(ids).toContain(d.id);
      expect(ids).toContain(e.id);
    });

    it('cap with pinned: evicts non-pinned first; pinned always survive', () => {
      const store = makeStore({ maxItemsPerSession: 3 });
      // Add 2 pinned + 4 non-pinned interleaved.
      const p1 = store.add('s', { content: 'p1', pinned: true });
      const n1 = store.add('s', { content: 'n1', pinned: false, ttlMs: 100_000 });
      const p2 = store.add('s', { content: 'p2', pinned: true });
      const n2 = store.add('s', { content: 'n2', pinned: false, ttlMs: 100_000 });
      const n3 = store.add('s', { content: 'n3', pinned: false, ttlMs: 100_000 });
      const n4 = store.add('s', { content: 'n4', pinned: false, ttlMs: 100_000 });
      const items = store.list('s');
      expect(items.length).toBe(3);
      const ids = items.map((i) => i.id);
      // Pinned always survive.
      expect(ids).toContain(p1.id);
      expect(ids).toContain(p2.id);
      // Non-pinned: only 1 slot remains (3 - 2 pinned); oldest non-pinned are dropped.
      // n1 and n2 are the oldest non-pinned, so n4 should survive (newest).
      expect(ids).not.toContain(n1.id);
      expect(ids).not.toContain(n2.id);
      expect(ids).not.toContain(n3.id);
      expect(ids).toContain(n4.id);
    });

    it('delete returns false for unknown id and true for existing id; item disappears from list', () => {
      const store = makeStore();
      const item = store.add('group:1', { content: 'to delete', pinned: true });
      expect(store.delete('group:1', 'nonexistent')).toBe(false);
      expect(store.delete('group:1', item.id)).toBe(true);
      expect(store.list('group:1').some((i) => i.id === item.id)).toBe(false);
    });

    it('clear empties that session; other sessions untouched', () => {
      const store = makeStore();
      store.add('group:1', { content: 'a', pinned: true });
      store.add('group:1', { content: 'b', pinned: true });
      store.add('group:2', { content: 'c', pinned: true });
      store.clear('group:1');
      expect(store.list('group:1').length).toBe(0);
      expect(store.list('group:2').length).toBe(1);
    });
  });
}
