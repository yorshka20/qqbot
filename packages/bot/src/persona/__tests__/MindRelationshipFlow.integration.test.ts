// Integration test: full write→DB→read path for Mind Phase 2 relationships.
//
// Simulates the hook flow:
//   1. RelationshipUpdater.update() writes to SQLite (write path)
//   2. buildPromptPatchAsync() reads back from the same store (read path)
//   3. Verifies the prompt patch reflects what was written
//
// Uses a real SQLiteAdapter + migration (same as EpigeneticsStore tests).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { buildPromptPatchAsync, renderPromptPatchFragment } from '../prompt/PromptPatchAssembler';
import { EpigeneticsStore } from '../reflection/epigenetics/EpigeneticsStore';
import { RelationshipUpdater } from '../reflection/relationships/RelationshipUpdater';
import { DEFAULT_PERSONA_CONFIG, mergePersonaConfig } from '../types';

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let adapter: SQLiteAdapter;
let store: EpigeneticsStore;
let cleanup: () => void;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mind-rel-flow-'));
  const dbPath = join(dir, 'test.db');
  adapter = new SQLiteAdapter(dbPath);
  await adapter.connect();
  await adapter.migrate();
  const db = adapter.getRawDb();
  if (!db) throw new Error('SQLiteAdapter.getRawDb() returned null after connect+migrate');
  store = new EpigeneticsStore(db);
  cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
});

afterEach(async () => {
  await adapter.disconnect();
  cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mindSnapshot(enabled = true) {
  const config = mergePersonaConfig({ enabled });
  return {
    enabled,
    personaId: config.personaId,
    phenotype: { fatigue: 0, attention: 0, stimulusCount: 0, lastStimulusAt: undefined },
    modulation: { intensityScale: 1, speedScale: 1, durationBias: 0 },
    capturedAt: Date.now(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MindRelationshipFlow integration', () => {
  it('write path updates DB row; read path injects relationshipSummary into prompt patch', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;
    const userId = 'user-integration-1';
    const updater = new RelationshipUpdater(store);

    // Simulate reply completion: positive user message
    await updater.update(personaId, userId, '谢谢你太棒了');

    // Verify DB row was created
    const row = await store.getRelationship(personaId, userId);
    expect(row).not.toBeNull();
    expect(row?.affinity).toBeGreaterThan(0);
    expect(row?.familiarity).toBeGreaterThan(0);

    // Read path: build async prompt patch
    const patch = await buildPromptPatchAsync(mindSnapshot(), { store, userId });
    expect(patch.relationshipSummary).toBeDefined();
    expect(patch.relationshipSummary).not.toContain('首次');

    // Rendered fragment includes relationship_state block
    const fragment = renderPromptPatchFragment(patch);
    expect(fragment).toContain('<relationship_state>');
  });

  it('first interaction (no DB row) → prompt patch contains 首次', async () => {
    const userId = 'user-never-seen';

    const patch = await buildPromptPatchAsync(mindSnapshot(), { store, userId });
    expect(patch.relationshipSummary).toContain('首次');
  });

  it('multiple interactions accumulate familiarity in DB', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;
    const userId = 'user-multi';
    const updater = new RelationshipUpdater(store);

    for (let i = 0; i < 10; i++) {
      await updater.update(personaId, userId, '今天天气真好');
    }

    const row = await store.getRelationship(personaId, userId);
    expect(row).not.toBeNull();
    expect(row?.familiarity).toBeCloseTo(0.01, 5);
  });

  it('missing store → patch has no relationshipSummary (graceful fallback)', async () => {
    const patch = await buildPromptPatchAsync(mindSnapshot(), { store: null, userId: 'u1' });
    expect(patch.relationshipSummary).toBeUndefined();
  });

  it('missing userId → patch has no relationshipSummary (graceful fallback)', async () => {
    const patch = await buildPromptPatchAsync(mindSnapshot(), { store, userId: null });
    expect(patch.relationshipSummary).toBeUndefined();
  });

  it('mind disabled → always returns empty patch even with store+userId', async () => {
    const patch = await buildPromptPatchAsync(mindSnapshot(false), { store, userId: 'u1' });
    expect(patch).toEqual({});
  });
});
