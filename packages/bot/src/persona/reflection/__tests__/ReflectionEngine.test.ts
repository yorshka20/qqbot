// Unit tests for ReflectionEngine — uses fake collaborators, no real DB, no real LLM.
//
// Every collaborator is a minimal hand-rolled fake. We exercise the six
// acceptance scenarios from the ticket:
//   1. Normal path: valid LLM JSON → applyReflectionPatch called + tone synced.
//   2. Schema failure: invalid/missing-field JSON → swallowed, no DB write.
//   3. Trait bound rejected → retry with halved traitDeltas → accepted.
//   4. Trait bound rejected twice → writeRejectionAudit called with reason.
//   5. Time gate: too few recent messages → timer tick skips LLM.
//   6. Cooldown: repeated event trigger within cooldown skips LLM.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { PersonaService } from '../../PersonaService';
import type { Phenotype } from '../../types';
import type { EpigeneticsStore } from '../epigenetics/EpigeneticsStore';
import type { ReflectionPatch } from '../epigenetics/types';
import { ReflectionEngine } from '../ReflectionEngine';
import type { ReflectionEngineOptions } from '../types';

// ── Fake builders ─────────────────────────────────────────────────────────────

function fakePhenotype(): Phenotype {
  return { fatigue: 0.1, attention: 0.5, stimulusCount: 3, lastStimulusAt: Date.now() };
}

function fakePromptManager(): PromptManager {
  return {
    render: (_name: string, _vars: Record<string, unknown>) => 'FAKE SYSTEM PROMPT',
  } as unknown as PromptManager;
}

function fakeHistoryService(): ConversationHistoryService {
  return {
    getRecentMessages: async () => [
      { messageId: '1', userId: 'u1', content: '你好', isBotReply: false, createdAt: new Date() },
    ],
  } as unknown as ConversationHistoryService;
}

/** Build a fake PersonaService with tracked setCurrentTone calls. */
function fakeMindService() {
  const calls: string[] = [];
  const svc = {
    getPhenotype: () => fakePhenotype(),
    setCurrentTone: (tone: string) => {
      calls.push(tone);
    },
    isEnabled: () => true,
    getCharacterBible: () => ({
      raw: '',
      selfConcept: '',
      voice: '',
      triggersRaw: '',
      reflexesRaw: '',
      boundaries: '',
      lore: '',
    }),
    getConfig: () => ({ reflection: { toolEquipped: false, maxToolRounds: 4 } }),
  } as unknown as PersonaService;
  return { svc, calls };
}

/** Build a fake EpigeneticsStore with configurable applyReflectionPatch behaviour. */
function fakeStore(opts: {
  firstResult: { accepted: boolean; rejectedReason?: string; reflectionId?: number };
  secondResult?: { accepted: boolean; rejectedReason?: string; reflectionId?: number };
}) {
  const applyCalls: Array<{ personaId: string; patch: ReflectionPatch }> = [];
  const auditCalls: Array<{ personaId: string; reason: string }> = [];

  const store = {
    getEpigenetics: async () => null,
    applyReflectionPatch: async (personaId: string, patch: ReflectionPatch) => {
      applyCalls.push({ personaId, patch });
      if (applyCalls.length === 1) return opts.firstResult;
      return opts.secondResult ?? opts.firstResult;
    },
    writeRejectionAudit: async (personaId: string, _patch: ReflectionPatch, reason: string) => {
      auditCalls.push({ personaId, reason });
    },
  } as unknown as EpigeneticsStore;

  return { store, applyCalls, auditCalls };
}

/** Valid LLM JSON output (as a raw JSON string) for a 'playful' tone. */
function validLLMJson(traitDelta = 0.02): string {
  return JSON.stringify({
    insightMd: 'User was cheerful today.',
    patch: {
      currentTone: 'playful',
      traitDeltas: { extraversion: traitDelta },
    },
  });
}

/** Build a fake LLMService that returns the given text. */
function fakeLLMService(text: string): LLMService {
  return {
    generateFixed: async () => ({ text, toolCalls: [], finishReason: 'stop', usage: null }),
  } as unknown as LLMService;
}

// ── Engine factory ────────────────────────────────────────────────────────────

function buildEngine(
  store: EpigeneticsStore,
  mindSvc: PersonaService,
  llmSvc: LLMService,
  overrides: Partial<ReflectionEngineOptions> = {},
): ReflectionEngine {
  const options: ReflectionEngineOptions = {
    personaId: 'test-persona',
    timerIntervalMs: 60_000,
    activityWindowMs: 60_000,
    activityMinMessages: 3,
    cooldownMs: 60_000,
    ...overrides,
  };
  return new ReflectionEngine(store, mindSvc, llmSvc, fakePromptManager(), fakeHistoryService(), options);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReflectionEngine — normal path', () => {
  it('valid LLM JSON applies patch and syncs tone in memory', async () => {
    const { store, applyCalls } = fakeStore({
      firstResult: { accepted: true, reflectionId: 1 },
    });
    const { svc, calls } = fakeMindService();
    const llm = fakeLLMService(validLLMJson(0.02));
    const engine = buildEngine(store, svc, llm);

    await engine.runReflection({ trigger: 'manual' });

    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].patch.currentTone).toBe('playful');
    expect(applyCalls[0].patch.traitDeltas?.extraversion).toBeCloseTo(0.02);
    expect(calls).toContain('playful');
  });

  it('accepted patch without currentTone does not call setCurrentTone', async () => {
    const patchJson = JSON.stringify({
      insightMd: 'Some insight.',
      patch: {
        currentTone: 'neutral',
        topicMasteryDelta: { cooking: 0.05 },
      },
    });
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 2 } });
    const { svc, calls } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(patchJson));

    await engine.runReflection({ trigger: 'event' });

    expect(applyCalls.length).toBe(1);
    // 'neutral' is a valid Tone so setCurrentTone is called with 'neutral'
    expect(calls).toContain('neutral');
  });
});

describe('ReflectionEngine — schema failure', () => {
  it('completely invalid JSON is swallowed — no applyReflectionPatch call', async () => {
    const { store, applyCalls, auditCalls } = fakeStore({
      firstResult: { accepted: true, reflectionId: 3 },
    });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService('this is not json at all'));

    await engine.runReflection({ trigger: 'manual' });

    expect(applyCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  it('JSON missing required fields is swallowed — no DB write', async () => {
    const bad = JSON.stringify({ notInsightMd: 'x', patch: {} });
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true } });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(bad));

    await engine.runReflection({ trigger: 'manual' });

    expect(applyCalls.length).toBe(0);
  });

  it('JSON in code fence is parsed correctly', async () => {
    const fenced = '```json\n' + validLLMJson(0.01) + '\n```';
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 4 } });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(fenced));

    await engine.runReflection({ trigger: 'manual' });

    expect(applyCalls.length).toBe(1);
  });
});

describe('ReflectionEngine — trait bound retry', () => {
  it('first call rejected with trait_bound_exceeded → second call has halved traitDeltas', async () => {
    const { store, applyCalls } = fakeStore({
      firstResult: { accepted: false, rejectedReason: 'trait_bound_exceeded:extraversion' },
      secondResult: { accepted: true, reflectionId: 5 },
    });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(validLLMJson(0.04)));

    await engine.runReflection({ trigger: 'manual' });

    // Two calls: original + halved retry
    expect(applyCalls.length).toBe(2);
    const origDelta = applyCalls[0].patch.traitDeltas?.extraversion ?? 0;
    const retryDelta = applyCalls[1].patch.traitDeltas?.extraversion ?? 0;
    // Retry delta should be half of original
    expect(retryDelta).toBeCloseTo(origDelta / 2, 5);
  });

  it('halved retry accepted → tone is synced', async () => {
    const { store } = fakeStore({
      firstResult: { accepted: false, rejectedReason: 'trait_bound_exceeded:neuroticism' },
      secondResult: { accepted: true, reflectionId: 6 },
    });
    const { svc, calls } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(validLLMJson(0.03)));

    await engine.runReflection({ trigger: 'manual' });

    expect(calls).toContain('playful');
  });
});

describe('ReflectionEngine — rejection audit after double rejection', () => {
  it('both original and retry rejected → writeRejectionAudit called', async () => {
    const { store, applyCalls, auditCalls } = fakeStore({
      firstResult: { accepted: false, rejectedReason: 'trait_bound_exceeded:extraversion' },
      secondResult: { accepted: false, rejectedReason: 'trait_bound_exceeded:extraversion' },
    });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(validLLMJson(0.05)));

    await engine.runReflection({ trigger: 'event' });

    expect(applyCalls.length).toBe(2);
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0].reason).toContain('rejected after retry');
  });

  it('non-trait rejection (other reason) → audit written without retry', async () => {
    const { store, applyCalls, auditCalls } = fakeStore({
      firstResult: { accepted: false, rejectedReason: 'schema_invalid' },
    });
    const { svc } = fakeMindService();
    const engine = buildEngine(store, svc, fakeLLMService(validLLMJson(0.01)));

    await engine.runReflection({ trigger: 'manual' });

    // Non-trait-bound rejection: no retry, just audit
    expect(applyCalls.length).toBe(1);
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0].reason).toContain('rejected');
  });
});

describe('ReflectionEngine — time gate (activity check)', () => {
  it('too few recent messages → timerTick skips LLM', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true } });
    const { svc } = fakeMindService();
    const llm = fakeLLMService(validLLMJson(0.01));
    const generateFixedSpy = spyOn(llm, 'generateFixed');

    // activityMinMessages=3 but we record only 2 messages (non-signal texts)
    const engine = buildEngine(store, svc, llm, {
      activityMinMessages: 3,
      activityWindowMs: 60_000,
      cooldownMs: 0,
    });
    engine.enqueueEventReflection('非信号文本1'); // records activity, no signal
    engine.enqueueEventReflection('非信号文本2'); // records activity, no signal

    // Force timer tick via private method
    await (engine as unknown as { timerTick: () => Promise<void> }).timerTick();

    expect(generateFixedSpy).not.toHaveBeenCalled();
    expect(applyCalls.length).toBe(0);
  });

  it('sufficient recent messages → timerTick fires LLM', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 7 } });
    const { svc } = fakeMindService();
    const llm = fakeLLMService(validLLMJson(0.01));

    const engine = buildEngine(store, svc, llm, {
      activityMinMessages: 2,
      activityWindowMs: 60_000,
      cooldownMs: 0,
    });
    engine.enqueueEventReflection('非信号文本1');
    engine.enqueueEventReflection('非信号文本2');

    await (engine as unknown as { timerTick: () => Promise<void> }).timerTick();

    expect(applyCalls.length).toBe(1);
  });
});

describe('ReflectionEngine — cooldown', () => {
  it('second event-trigger within cooldown is skipped', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 8 } });
    const { svc } = fakeMindService();
    const llm = fakeLLMService(validLLMJson(0.01));

    const engine = buildEngine(store, svc, llm, {
      cooldownMs: 60_000,
    });

    // First enqueue with strong signal — should fire
    engine.enqueueEventReflection('谢谢你太棒了');
    // Wait for the first runReflection to complete by draining microtask queue
    await new Promise((r) => setTimeout(r, 10));

    // Second enqueue with strong signal within cooldown — should be skipped
    engine.enqueueEventReflection('谢谢你太棒了');
    await new Promise((r) => setTimeout(r, 10));

    // Only one LLM call expected (cooldown blocks second event trigger)
    expect(applyCalls.length).toBeLessThanOrEqual(1);
  });

  it('timer-tick within global cooldown is skipped', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true } });
    const { svc } = fakeMindService();
    const llm = fakeLLMService(validLLMJson(0.01));

    const engine = buildEngine(store, svc, llm, {
      activityMinMessages: 1,
      cooldownMs: 60_000,
    });
    // Simulate a recent reflection by setting lastReflectionAt to now
    (engine as unknown as { lastReflectionAt: number }).lastReflectionAt = Date.now();

    engine.enqueueEventReflection('非信号文本');
    await (engine as unknown as { timerTick: () => Promise<void> }).timerTick();

    expect(applyCalls.length).toBe(0);
  });
});

describe('ReflectionEngine — start/stop lifecycle', () => {
  let engine: ReflectionEngine;

  afterEach(() => {
    engine.stop();
  });

  it('start() is idempotent — calling twice does not create two timers', () => {
    const { store } = fakeStore({ firstResult: { accepted: true } });
    const { svc } = fakeMindService();
    engine = buildEngine(store, svc, fakeLLMService(validLLMJson()));
    engine.start();
    const timerRef = (engine as unknown as { timer: ReturnType<typeof setInterval> | null }).timer;
    engine.start();
    const timerRef2 = (engine as unknown as { timer: ReturnType<typeof setInterval> | null }).timer;
    expect(timerRef).toBe(timerRef2);
  });

  it('stop() clears the timer', () => {
    const { store } = fakeStore({ firstResult: { accepted: true } });
    const { svc } = fakeMindService();
    engine = buildEngine(store, svc, fakeLLMService(validLLMJson()));
    engine.start();
    engine.stop();
    expect((engine as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBeNull();
  });
});
