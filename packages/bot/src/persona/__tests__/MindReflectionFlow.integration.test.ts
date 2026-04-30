// Integration test: full reflection cycle using a real SQLite store.
//
// Simulates the flow:
//   1. ReflectionEngine receives a fake LLM response with tone='playful'.
//   2. applyReflectionPatch writes to SQLite (real store, real migration).
//   3. After successful write, PersonaService.setCurrentTone is called.
//   4. buildPromptPatchAsync reads back from the same store and returns
//      a tonePromptFragment for 'playful'.
//
// The LLM is stubbed so no network calls are made.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InternalEventBus } from '@/agenda/InternalEventBus';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { EpigeneticsStore } from '../reflection/epigenetics/EpigeneticsStore';
import { PersonaService } from '../PersonaService';
import { buildPromptPatchAsync, renderPromptPatchFragment } from '../prompt/PromptPatchAssembler';
import { ReflectionEngine } from '../reflection/ReflectionEngine';
import { DEFAULT_PERSONA_CONFIG } from '../types';

// ── Fake helpers ──────────────────────────────────────────────────────────────

function fakePromptManager(): PromptManager {
  return {
    render: () => 'FAKE REFLECTION SYSTEM PROMPT',
  } as unknown as PromptManager;
}

function fakeHistoryService(): ConversationHistoryService {
  return {
    getRecentMessages: async () => [],
  } as unknown as ConversationHistoryService;
}

function fakeLLMServiceWith(text: string): LLMService {
  return {
    generateFixed: async () => ({ text, toolCalls: [], finishReason: 'stop', usage: null }),
  } as unknown as LLMService;
}

function reflectionJson(tone: string, traitDelta = 0.02): string {
  return JSON.stringify({
    insightMd: 'Integration test reflection.',
    patch: {
      currentTone: tone,
      traitDeltas: { extraversion: traitDelta },
    },
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let adapter: SQLiteAdapter;
let store: EpigeneticsStore;
let mind: PersonaService;
let cleanup: () => void;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mind-refl-flow-'));
  const dbPath = join(dir, 'test.db');
  adapter = new SQLiteAdapter(dbPath);
  await adapter.connect();
  await adapter.migrate();
  const db = adapter.getRawDb();
  if (!db) throw new Error('SQLiteAdapter.getRawDb() returned null');
  store = new EpigeneticsStore(db);
  mind = new PersonaService({ ...DEFAULT_PERSONA_CONFIG, enabled: true }, new InternalEventBus());
  mind.setEpigeneticsStore(store);
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

// ── Tests ─────────────────────────────────────────────────name───────────────

describe('MindReflectionFlow integration', () => {
  it('fake LLM cycle updates store + PersonaService tone; next buildPromptPatchAsync observes tonePromptFragment', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;
    const userId = 'integration-user';

    const engine = new ReflectionEngine(
      store,
      mind,
      fakeLLMServiceWith(reflectionJson('playful', 0.02)),
      fakePromptManager(),
      fakeHistoryService(),
      {
        personaId,
        cooldownMs: 0,
        activityMinMessages: 1,
      },
    );

    // Record activity so timer tick is allowed
    engine.enqueueEventReflection('非信号文本');

    // Run reflection manually (synchronous-friendly for test)
    await engine.runReflection({ trigger: 'manual' });

    // PersonaService tone should have been updated to 'playful'
    expect(mind.getCurrentTone()).toBe('playful');

    // EpigeneticsStore should persist currentTone under behavioralBiases
    const epi = await store.getEpigenetics(personaId);
    expect(epi).not.toBeNull();
    expect(epi?.behavioralBiases['currentTone']).toBe('playful');

    // buildPromptPatchAsync should return tonePromptFragment for 'playful'
    const mindSnapshot = mind.getSnapshot();
    const patch = await buildPromptPatchAsync(mindSnapshot, { store, userId });
    expect(patch.tonePromptFragment).toBeDefined();
    expect(patch.tonePromptFragment).not.toBe('');

    // Rendered fragment includes tone_state block
    const fragment = renderPromptPatchFragment(patch);
    expect(fragment).toContain('<tone_state>');
    expect(fragment).toContain('轻快'); // part of playful promptFragment
  });

  it('neutral tone → no tonePromptFragment injected', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;
    const userId = 'integration-user-2';

    const engine = new ReflectionEngine(
      store,
      mind,
      fakeLLMServiceWith(reflectionJson('neutral', 0.01)),
      fakePromptManager(),
      fakeHistoryService(),
      {
        personaId,
        cooldownMs: 0,
      },
    );

    await engine.runReflection({ trigger: 'manual' });

    const mindSnapshot = mind.getSnapshot();
    const patch = await buildPromptPatchAsync(mindSnapshot, { store, userId });
    // neutral tone has empty promptFragment → should be undefined
    expect(patch.tonePromptFragment).toBeUndefined();
  });

  it('reflection audit row is written on trait bound exceeded twice', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;

    // Pre-seed two 0.05 extraversion deltas to saturate the 0.10 bound
    const ins = { trigger: 'manual' as const, insightMd: 'seed' };
    await store.applyReflectionPatch(personaId, { traitDeltas: { extraversion: 0.05 } }, ins);
    await store.applyReflectionPatch(personaId, { traitDeltas: { extraversion: 0.05 } }, ins);

    // Now both 0.05 and halved 0.025 will exceed since window sum=0.10
    const engine = new ReflectionEngine(
      store,
      mind,
      fakeLLMServiceWith(reflectionJson('melancholy', 0.05)),
      fakePromptManager(),
      fakeHistoryService(),
      { personaId, cooldownMs: 0 },
    );

    await engine.runReflection({ trigger: 'event' });

    // There should be an audit (rejected) row in persona_reflections
    const reflections = await store.getRecentReflections(personaId, 10);
    const auditRow = reflections.find((r) => r.trigger === ('rejected' as PersonaReflectionTrigger));
    expect(auditRow).toBeDefined();
    expect(auditRow?.insightMd).toContain('rejected');
  });

  it('enqueueEventReflection with strong signal fires runReflection async', async () => {
    const personaId = DEFAULT_PERSONA_CONFIG.personaId;

    const engine = new ReflectionEngine(
      store,
      mind,
      fakeLLMServiceWith(reflectionJson('excited', 0.01)),
      fakePromptManager(),
      fakeHistoryService(),
      { personaId, cooldownMs: 0 },
    );

    // Strong signal: 谢谢
    engine.enqueueEventReflection('谢谢你太棒了', { groupId: 'group-1' });

    // Drain microtask queue + async chain
    await new Promise((r) => setTimeout(r, 50));

    expect(mind.getCurrentTone()).toBe('excited');
  });
});

// Type alias used in the audit test — PersonaReflection.trigger is extended to 'rejected' at DB level
type PersonaReflectionTrigger = 'time' | 'event' | 'manual' | 'rejected';
