import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { EpigeneticsHistoryToolExecutor } from '../EpigeneticsHistoryToolExecutor';
import { EpigeneticsStore } from '../EpigeneticsStore';

let adapter: SQLiteAdapter;
let store: EpigeneticsStore;
let cleanup: () => void;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'epi-hist-tool-'));
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

describe('EpigeneticsHistoryToolExecutor', () => {
  it('returns empty timeline + zeros when no reflections', async () => {
    const exec = new EpigeneticsHistoryToolExecutor(store);
    const r = await exec.execute(
      { type: 'epigenetics_history', parameters: { personaId: 'default', days: 7 }, executor: 'epigenetics_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
    expect((r.data as any).timeline).toEqual([]);
  });

  it('aggregates traitDeltasSum across reflections', async () => {
    const personaId = 'default';
    await store.applyReflectionPatch(
      personaId,
      { traitDeltas: { extraversion: 0.03 }, currentTone: 'playful' },
      { trigger: 'manual', insightMd: 'r1' },
    );
    // Ensure different timestamps so getRecentReflections DESC ordering is deterministic.
    await Bun.sleep(2);
    await store.applyReflectionPatch(
      personaId,
      { traitDeltas: { extraversion: 0.02, openness: -0.01 }, currentTone: 'excited' },
      { trigger: 'event', insightMd: 'r2' },
    );

    const exec = new EpigeneticsHistoryToolExecutor(store);
    const r = await exec.execute(
      { type: 'epigenetics_history', parameters: { personaId, days: 7 }, executor: 'epigenetics_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(2);
    expect((r.data as any).traitDeltasSum.extraversion as number).toBeCloseTo(0.05, 5);
    expect((r.data as any).traitDeltasSum.openness as number).toBeCloseTo(-0.01, 5);
    expect((r.data as any).toneTransitions).toEqual(['playful', 'excited']);
  });

  it('clamps days to [1, 30]', async () => {
    const exec = new EpigeneticsHistoryToolExecutor(store);
    const r1 = await exec.execute(
      { type: 'epigenetics_history', parameters: { personaId: 'default', days: 100 }, executor: 'epigenetics_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect((r1.data as any).days).toBe(30);
    const r2 = await exec.execute(
      { type: 'epigenetics_history', parameters: { personaId: 'default', days: 0 }, executor: 'epigenetics_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect((r2.data as any).days).toBe(1);
  });

  it('errors on missing personaId', async () => {
    const exec = new EpigeneticsHistoryToolExecutor(store);
    const r = await exec.execute(
      { type: 'epigenetics_history', parameters: {}, executor: 'epigenetics_history' },
      { userId: 'reflection', messageType: 'private' },
    );
    expect(r.success).toBe(false);
  });
});
