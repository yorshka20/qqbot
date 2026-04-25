// Tests for EpigeneticsStore — uses an in-memory SQLite DB via SQLiteAdapter
// so migrations run through the real migration path, not mocks.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { EpigeneticsStore } from '../EpigeneticsStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Each test gets its own unique temp DB file to prevent state leakage. */
async function buildStore(): Promise<{
  store: EpigeneticsStore;
  adapter: SQLiteAdapter;
  db: Database;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'epi-test-'));
  const dbPath = join(dir, 'test.db');
  const adapter = new SQLiteAdapter(dbPath);
  await adapter.connect();
  await adapter.migrate();
  const db = adapter.getRawDb()!;
  const store = new EpigeneticsStore(db);
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };
  return { store, adapter, db, cleanup };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EpigeneticsStore', () => {
  let store: EpigeneticsStore;
  let adapter: SQLiteAdapter;
  let db: Database;
  let cleanup: () => void;

  beforeEach(async () => {
    const built = await buildStore();
    store = built.store;
    adapter = built.adapter;
    db = built.db;
    cleanup = built.cleanup;
  });

  afterEach(async () => {
    await adapter.disconnect();
    cleanup();
  });

  // ── getEpigenetics ──────────────────────────────────────────────────────────

  it('returns null for absent persona', async () => {
    const result = await store.getEpigenetics('persona-A');
    expect(result).toBeNull();
  });

  // ── applyReflectionPatch — basic topic mastery write ───────────────────────

  it('first reflection write of topicMasteryDelta succeeds and reads back', async () => {
    const result = await store.applyReflectionPatch(
      'persona-A',
      { topicMasteryDelta: { coding: 0.1 } },
      { trigger: 'manual', insightMd: 'Knows coding.' },
    );

    expect(result.accepted).toBe(true);
    expect(result.reflectionId).toBeGreaterThan(0);

    const epi = await store.getEpigenetics('persona-A');
    expect(epi).not.toBeNull();
    expect(epi?.topicMastery.coding).toBeCloseTo(0.1);
  });

  // ── Trait bound enforcement ─────────────────────────────────────────────────

  it('trait bound: first two writes of extraversion=0.05 accepted, third rejected', async () => {
    const patch = { traitDeltas: { extraversion: 0.05 as const } };
    const ins = { trigger: 'manual' as const, insightMd: 'test' };

    const r1 = await store.applyReflectionPatch('persona-A', patch, ins);
    expect(r1.accepted).toBe(true);

    const r2 = await store.applyReflectionPatch('persona-A', patch, ins);
    expect(r2.accepted).toBe(true);

    // After two writes the 24 h window sum is 0.10 = TRAIT_BOUND_24H.
    // Adding another 0.05 would bring it to 0.15 > 0.10 → reject.
    const r3 = await store.applyReflectionPatch('persona-A', patch, ins);
    expect(r3.accepted).toBe(false);
    expect(r3.rejectedReason).toBe('trait_bound_exceeded:extraversion');

    // Persisted history must reflect only the two accepted writes.
    const epi = await store.getEpigenetics('persona-A');
    const windowSum = epi?.traitHistory.reduce((acc, e) => acc + (e.traitDeltas.extraversion ?? 0), 0);
    expect(windowSum).toBeCloseTo(0.1);
  });

  // ── 24 h sliding window pruning ────────────────────────────────────────────

  it('24h sliding window: old entry pruned; 0.05 accepted; 0.06 in-window rejected', async () => {
    // Manually insert an entry that is 25 h old directly into the epigenetics row.
    const now = Date.now();
    const oldTs = now - 25 * 60 * 60 * 1000;
    const oldHistory = JSON.stringify([{ ts: oldTs, traitDeltas: { extraversion: 0.05 } }]);
    db.query(
      `INSERT INTO persona_epigenetics
         (persona_id, topic_mastery_json, behavioral_biases_json,
          learned_preferences_json, forbidden_words_json, forbidden_topics_json,
          trait_history_json, updated_at)
       VALUES ('persona-B', '{}', '{}', '{}', '[]', '[]', ?, ?)`,
    ).run(oldHistory, now - 1);

    // Old entry (25 h ago, 0.05) is beyond the 24 h window → pruned.
    // New write of 0.05 should be accepted (window sum was 0).
    const r1 = await store.applyReflectionPatch(
      'persona-B',
      { traitDeltas: { extraversion: 0.05 } },
      { trigger: 'manual', insightMd: 'first' },
    );
    expect(r1.accepted).toBe(true);

    // Now window has 0.05; adding 0.06 would reach 0.11 > 0.10 → rejected.
    const r2 = await store.applyReflectionPatch(
      'persona-B',
      { traitDeltas: { extraversion: 0.06 } },
      { trigger: 'manual', insightMd: 'second' },
    );
    expect(r2.accepted).toBe(false);
    expect(r2.rejectedReason).toBe('trait_bound_exceeded:extraversion');
  });

  // ── forbiddenWords append-only ──────────────────────────────────────────────

  it('forbidden words: add foo then bar, both present; no remove surface', async () => {
    await store.applyReflectionPatch(
      'persona-A',
      { forbiddenWordsAdd: ['foo'] },
      { trigger: 'manual', insightMd: 'add foo' },
    );
    await store.applyReflectionPatch(
      'persona-A',
      { forbiddenWordsAdd: ['bar'] },
      { trigger: 'manual', insightMd: 'add bar' },
    );

    const epi = await store.getEpigenetics('persona-A');
    expect(epi?.forbiddenWords).toContain('foo');
    expect(epi?.forbiddenWords).toContain('bar');

    // Verify EpigeneticsStore has no remove method for forbiddenWords.
    // biome-ignore lint/suspicious/noExplicitAny: intentional type probe
    expect(typeof (store as any).removeForbiddenWord).toBe('undefined');
    // biome-ignore lint/suspicious/noExplicitAny: intentional type probe
    expect(typeof (store as any).clearForbiddenWords).toBe('undefined');
  });

  // ── Clamp behaviour ─────────────────────────────────────────────────────────

  it('topicMasteryDelta: delta=2 clamps to 1', async () => {
    await store.applyReflectionPatch(
      'persona-A',
      { topicMasteryDelta: { x: 2 } },
      { trigger: 'manual', insightMd: 'clamp topic' },
    );
    const epi = await store.getEpigenetics('persona-A');
    expect(epi?.topicMastery.x).toBe(1);
  });

  it('affinity: affinityDelta=-3 clamps to -1', async () => {
    await store.bumpRelationship('persona-A', 'user-1', { affinityDelta: -3 });
    const rel = await store.getRelationship('persona-A', 'user-1');
    expect(rel?.affinity).toBe(-1);
  });

  // ── Relationship increments ─────────────────────────────────────────────────

  it('five affinityDelta=0.1 writes result in affinity=0.5', async () => {
    for (let i = 0; i < 5; i++) {
      await store.bumpRelationship('persona-A', 'user-2', { affinityDelta: 0.1 });
    }
    const rel = await store.getRelationship('persona-A', 'user-2');
    expect(rel?.affinity).toBeCloseTo(0.5);
  });

  // ── listRelationships ordering ──────────────────────────────────────────────

  it('listRelationships with orderBy=affinity returns sorted order', async () => {
    await store.bumpRelationship('persona-A', 'user-low', { affinityDelta: 0.1 });
    await store.bumpRelationship('persona-A', 'user-high', { affinityDelta: 0.9 });
    await store.bumpRelationship('persona-A', 'user-mid', { affinityDelta: 0.5 });

    const list = await store.listRelationships('persona-A', { orderBy: 'affinity' });
    expect(list.length).toBeGreaterThanOrEqual(3);
    // First entry must have the highest affinity.
    expect(list[0].affinity).toBeGreaterThanOrEqual(list[1].affinity);
    expect(list[1].affinity).toBeGreaterThanOrEqual(list[2].affinity);
  });

  // ── getRecentReflections ────────────────────────────────────────────────────

  it('getRecentReflections includes trigger / insightMd / appliedPatch from a write', async () => {
    const patch = { topicMasteryDelta: { writing: 0.2 } };
    await store.applyReflectionPatch('persona-A', patch, {
      trigger: 'event',
      insightMd: 'User discussed writing extensively.',
    });

    const reflections = await store.getRecentReflections('persona-A', 5);
    expect(reflections.length).toBeGreaterThan(0);

    const r = reflections[0];
    expect(r.trigger).toBe('event');
    expect(r.insightMd).toBe('User discussed writing extensively.');
    expect(r.appliedPatch.topicMasteryDelta?.writing).toBeCloseTo(0.2);
  });

  // ── Migration idempotency ───────────────────────────────────────────────────

  it('repeated connect+migrate on same DB does not throw', async () => {
    // Use a fresh unique temp path to avoid interfering with the beforeEach DB.
    const dir2 = mkdtempSync(join(tmpdir(), 'epi-idem-'));
    const tmpAdapter = new SQLiteAdapter(join(dir2, 'idem.db'));
    try {
      await tmpAdapter.connect();
      await tmpAdapter.migrate();
      // Running migrate() a second time must be idempotent (all CREATE ... IF NOT EXISTS).
      await expect(tmpAdapter.migrate()).resolves.toBeUndefined();
    } finally {
      await tmpAdapter.disconnect();
      try {
        rmSync(dir2, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
