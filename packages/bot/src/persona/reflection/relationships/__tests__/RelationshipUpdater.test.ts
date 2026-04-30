import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { EpigeneticsStore } from '../../epigenetics/EpigeneticsStore';
import { classifyAffinityDelta, RelationshipUpdater } from '../RelationshipUpdater';

// ─── classifyAffinityDelta ────────────────────────────────────────────────────

describe('classifyAffinityDelta', () => {
  test('positive keywords → +0.01', () => {
    expect(classifyAffinityDelta('谢谢，太喜欢了')).toBeCloseTo(0.01, 10);
  });

  test('negative keywords → -0.01', () => {
    expect(classifyAffinityDelta('你不对，抬杠')).toBeCloseTo(-0.01, 10);
  });

  test('no keywords → 0', () => {
    expect(classifyAffinityDelta('今天天气真好')).toBe(0);
  });

  test('positive keyword 666 → +0.01', () => {
    expect(classifyAffinityDelta('666 牛啊')).toBeCloseTo(0.01, 10);
  });

  test('negative keyword 烦 → -0.01', () => {
    expect(classifyAffinityDelta('好烦啊')).toBeCloseTo(-0.01, 10);
  });

  test('positive wins when only positive keywords present', () => {
    expect(classifyAffinityDelta('真棒可爱')).toBeCloseTo(0.01, 10);
  });

  test('empty string → 0', () => {
    expect(classifyAffinityDelta('')).toBe(0);
  });
});

// ─── RelationshipUpdater integration-level (mock store) ───────────────────────

// Minimal mock for EpigeneticsStore needed by RelationshipUpdater.
class MockStore {
  readonly calls: Array<{
    personaId: string;
    userId: string;
    delta: { affinityDelta?: number; familiarityDelta?: number };
    source: string;
  }> = [];

  async bumpRelationship(
    personaId: string,
    userId: string,
    delta: { affinityDelta?: number; familiarityDelta?: number },
    source: 'message' | 'reflection' = 'message',
  ): Promise<void> {
    this.calls.push({ personaId, userId, delta, source });
  }
}

describe('RelationshipUpdater.update', () => {
  test('positive message → affinityDelta=+0.01, familiarityDelta=0.001', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '谢谢，太喜欢了');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].delta.affinityDelta).toBeCloseTo(0.01, 10);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('negative message → affinityDelta=-0.01', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '你不对，抬杠');
    expect(store.calls[0].delta.affinityDelta).toBeCloseTo(-0.01, 10);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('neutral message → affinityDelta=0, familiarityDelta=0.001', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '今天天气真好');
    expect(store.calls[0].delta.affinityDelta).toBe(0);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('100 neutral messages accumulate familiarity to 0.1', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    for (let i = 0; i < 100; i++) {
      await updater.update('default', 'user1', '今天天气真好');
    }
    const totalFamiliarity = store.calls.reduce((acc, c) => acc + (c.delta.familiarityDelta ?? 0), 0);
    expect(totalFamiliarity).toBeCloseTo(0.1, 5);
  });

  test('personaId and userId are forwarded to store', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('persona-x', 'user-42', '');
    expect(store.calls[0].personaId).toBe('persona-x');
    expect(store.calls[0].userId).toBe('user-42');
  });

  test('source="message" is forwarded to store', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('persona-x', 'user-42', '');
    expect(store.calls[0].source).toBe('message');
  });
});

// ─── RelationshipUpdater integration (real DB) ───────────────────────────────

describe('RelationshipUpdater.update — integration with real DB', () => {
  let adapter: SQLiteAdapter;
  let cleanup: () => void;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-updater-test-'));
    const dbPath = join(dir, 'test.db');
    adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
    await adapter.migrate();
    cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    };
  });

  afterEach(async () => {
    await adapter.disconnect();
    cleanup();
  });

  test('update records event with source=message and eventType=init', async () => {
    const db = adapter.getRawDb()!;
    const store = new EpigeneticsStore(db);
    const updater = new RelationshipUpdater(store);
    await updater.update('p1', 'u1', '谢谢');
    const events = await store.getRelationshipEvents('p1', 'u1');
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('message');
    expect(events[0].eventType).toBe('init');
  });
});
