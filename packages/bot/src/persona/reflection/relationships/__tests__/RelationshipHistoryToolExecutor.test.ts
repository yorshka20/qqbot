import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { EpigeneticsStore } from '../../epigenetics/EpigeneticsStore';
import { RelationshipHistoryToolExecutor } from '../RelationshipHistoryToolExecutor';

let adapter: SQLiteAdapter;
let store: EpigeneticsStore;
let cleanup: () => void;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rel-hist-tool-'));
  const dbPath = join(dir, 'test.db');
  adapter = new SQLiteAdapter(dbPath);
  await adapter.connect();
  await adapter.migrate();
  const db = adapter.getRawDb();
  if (!db) throw new Error('null raw db');
  store = new EpigeneticsStore(db);
  cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
});

afterEach(async () => {
  await adapter.disconnect();
  cleanup();
});

describe('RelationshipHistoryToolExecutor', () => {
  it('returns empty events + null snapshot when no relationship', async () => {
    const exec = new RelationshipHistoryToolExecutor(store);
    const r = await exec.execute(
      {
        type: 'relationship_history',
        parameters: { personaId: 'default', userId: 'u-x' },
        executor: 'relationship_history',
      },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r.success).toBe(true);
    expect((r.data as any).eventCount).toBe(0);
    expect((r.data as any).currentAffinity).toBeNull();
  });

  it('returns events ordered DESC + correct current snapshot', async () => {
    await store.bumpRelationship('p1', 'u1', { affinityDelta: 0.01, familiarityDelta: 0.001 });
    // Ensure different timestamps so DESC ordering is deterministic.
    await Bun.sleep(2);
    await store.bumpRelationship('p1', 'u1', { affinityDelta: -0.02, familiarityDelta: 0.001 });

    const exec = new RelationshipHistoryToolExecutor(store);
    const r = await exec.execute(
      {
        type: 'relationship_history',
        parameters: { personaId: 'p1', userId: 'u1', sinceDays: 1 },
        executor: 'relationship_history',
      },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r.success).toBe(true);
    expect((r.data as any).eventCount).toBe(2);
    const events = (r.data as any).events as Array<{ eventType: string; source: string }>;
    expect(events[0].eventType).toBe('update'); // most recent first
    expect(events[1].eventType).toBe('init');
    expect(events.every((e) => e.source === 'message')).toBe(true);
    expect((r.data as any).currentAffinity).toBeCloseTo(-0.01, 5);
  });

  it('errors on missing personaId or userId', async () => {
    const exec = new RelationshipHistoryToolExecutor(store);
    const r1 = await exec.execute(
      { type: 'relationship_history', parameters: { userId: 'u1' }, executor: 'relationship_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r1.success).toBe(false);
    const r2 = await exec.execute(
      { type: 'relationship_history', parameters: { personaId: 'p1' }, executor: 'relationship_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r2.success).toBe(false);
  });
});
