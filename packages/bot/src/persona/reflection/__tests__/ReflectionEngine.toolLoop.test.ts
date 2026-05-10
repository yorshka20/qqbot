// Unit tests for ReflectionEngine tool-equipped agent loop.
//
// Verifies:
//   1. 2-round tool dialogue: round 1 calls a tool, round 2 returns final JSON.
//   2. maxToolRounds=0 → falls through to single-call path (generateFixed called).
//   3. Invalid JSON at end of loop → falls back to single-call path; reflection still completes.
//   4. toolEquipped=false → generateWithTools never called.

import { describe, expect, it, mock } from 'bun:test';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ToolUseGenerateResponse } from '@/ai/types';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { HookManager } from '@/hooks/HookManager';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import type { PersonaService } from '../../PersonaService';
import type { PersonaConfig } from '../../types';
import type { EpigeneticsStore } from '../epigenetics/EpigeneticsStore';
import type { ReflectionPatch } from '../epigenetics/types';
import { ReflectionEngine } from '../ReflectionEngine';
import type { ReflectionEngineOptions } from '../types';

// ── Shared fakes ──────────────────────────────────────────────────────────────

function fakePromptManager(): PromptManager {
  return {
    render: (_name: string, _vars: Record<string, unknown>) => 'FAKE SYSTEM PROMPT',
  } as unknown as PromptManager;
}

function fakeHistoryService(): ConversationHistoryService {
  return {
    getRecentMessages: async () => [],
  } as unknown as ConversationHistoryService;
}

function fakeMindService(reflectionCfg?: PersonaConfig['reflection']) {
  const svc = {
    getPhenotype: () => ({ fatigue: 0.1, attention: 0.3, stimulusCount: 1 }),
    setCurrentTone: mock(() => {}),
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
    getConfig: () => ({
      reflection: reflectionCfg ?? { toolEquipped: false, maxToolRounds: 4 },
    }),
  } as unknown as PersonaService;
  return svc;
}

function fakeStore(opts: { firstResult: { accepted: boolean; reflectionId?: number; rejectedReason?: string } }) {
  const applyCalls: Array<{ personaId: string; patch: ReflectionPatch }> = [];
  const store = {
    getEpigenetics: async () => null,
    applyReflectionPatch: async (personaId: string, patch: ReflectionPatch) => {
      applyCalls.push({ personaId, patch });
      return opts.firstResult;
    },
    writeRejectionAudit: async () => {},
  } as unknown as EpigeneticsStore;
  return { store, applyCalls };
}

/** Valid final JSON text that passes ReflectionOutputSchema. */
function validFinalJson(): string {
  return JSON.stringify({
    insightMd: 'Tool-assisted reflection insight.',
    patch: { currentTone: 'playful' },
  });
}

/** Build a fake ToolManager that returns one reflection-scope tool. */
function fakeToolManager(): ToolManager {
  const dummySpec: ToolSpec = {
    name: 'epigenetics_history',
    description: 'Fake epigenetics history tool',
    executor: 'EpigeneticsHistoryToolExecutor',
    visibility: { reflection: true },
    parameters: {},
  };
  return {
    getToolsByScope: (scope: string) => (scope === 'reflection' ? [dummySpec] : []),
    toToolDefinitions: (specs: ToolSpec[]) =>
      specs.map((s) => ({
        name: s.name,
        description: s.description,
        parameters: { type: 'object', properties: {}, required: [] },
      })),
    getTool: (name: string) => (name === 'epigenetics_history' ? dummySpec : undefined),
    getExecutor: () => ({ name: 'fake', execute: async () => ({ success: true, reply: 'fake result' }) }),
    execute: async () => ({ success: true, reply: 'fake tool result' }),
  } as unknown as ToolManager;
}

/** Build a fake HookManager that always allows execution. */
function fakeHookManager(): HookManager {
  return {
    execute: async () => true,
  } as unknown as HookManager;
}

// ── Engine factory ────────────────────────────────────────────────────────────

function buildEngine(opts: {
  store: EpigeneticsStore;
  mindSvc: PersonaService;
  llmSvc: LLMService;
  toolManager?: ToolManager;
  hookManager?: HookManager;
  options?: Partial<ReflectionEngineOptions>;
}): ReflectionEngine {
  const engineOptions: ReflectionEngineOptions = {
    personaId: 'test-persona',
    timerIntervalMs: 60_000,
    activityWindowMs: 60_000,
    activityMinMessages: 3,
    cooldownMs: 60_000,
    ...opts.options,
  };
  return new ReflectionEngine(
    opts.store,
    opts.mindSvc,
    opts.llmSvc,
    fakePromptManager(),
    fakeHistoryService(),
    engineOptions,
    opts.toolManager,
    opts.hookManager,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReflectionEngine — tool-equipped agent loop (toolEquipped=true)', () => {
  it('2-round dialogue: round 1 tool call, round 2 final JSON → patch applied', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 100 } });

    // generateWithTools is scripted: returns final JSON after the loop.
    const generateWithToolsMock = mock(
      async (): Promise<ToolUseGenerateResponse> => ({
        text: validFinalJson(),
        stopReason: 'end_turn',
        toolCalls: [],
      }),
    );
    const llmSvc = {
      generateFixed: mock(async () => ({ text: validFinalJson() })),
      generateWithTools: generateWithToolsMock,
    } as unknown as LLMService;

    const mindSvc = fakeMindService({ toolEquipped: true, maxToolRounds: 2 });
    const engine = buildEngine({
      store,
      mindSvc,
      llmSvc,
      toolManager: fakeToolManager(),
      hookManager: fakeHookManager(),
    });

    await engine.runReflection({ trigger: 'manual' });

    // generateWithTools was called (agent loop path).
    expect(generateWithToolsMock).toHaveBeenCalledTimes(1);
    // Patch was applied.
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].patch.currentTone).toBe('playful');
    // generateFixed was NOT called (loop succeeded, no fallback needed).
    expect(llmSvc.generateFixed as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  it('maxToolRounds=0 → falls through to single-call path, generateFixed called', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 101 } });

    const generateWithToolsMock = mock(
      async (): Promise<ToolUseGenerateResponse> => ({
        text: '',
        stopReason: 'end_turn',
        toolCalls: [],
      }),
    );
    const generateFixedMock = mock(async () => ({ text: validFinalJson() }));
    const llmSvc = {
      generateFixed: generateFixedMock,
      generateWithTools: generateWithToolsMock,
    } as unknown as LLMService;

    // maxToolRounds=0 disables the loop even with toolEquipped=true.
    const mindSvc = fakeMindService({ toolEquipped: true, maxToolRounds: 0 });
    const engine = buildEngine({
      store,
      mindSvc,
      llmSvc,
      toolManager: fakeToolManager(),
      hookManager: fakeHookManager(),
    });

    await engine.runReflection({ trigger: 'manual' });

    // generateWithTools NOT called (maxToolRounds=0).
    expect(generateWithToolsMock).not.toHaveBeenCalled();
    // generateFixed called instead.
    expect(generateFixedMock).toHaveBeenCalledTimes(1);
    expect(applyCalls.length).toBe(1);
  });

  it('invalid JSON at end of loop → fallback to single-call, reflection still completes', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 102 } });

    // Tool loop returns invalid JSON; single-call returns valid JSON.
    const generateWithToolsMock = mock(
      async (): Promise<ToolUseGenerateResponse> => ({
        text: 'this is not json',
        stopReason: 'end_turn',
        toolCalls: [],
      }),
    );
    const generateFixedMock = mock(async () => ({ text: validFinalJson() }));
    const llmSvc = {
      generateFixed: generateFixedMock,
      generateWithTools: generateWithToolsMock,
    } as unknown as LLMService;

    const mindSvc = fakeMindService({ toolEquipped: true, maxToolRounds: 3 });
    const engine = buildEngine({
      store,
      mindSvc,
      llmSvc,
      toolManager: fakeToolManager(),
      hookManager: fakeHookManager(),
    });

    await engine.runReflection({ trigger: 'manual' });

    // Agent loop was attempted.
    expect(generateWithToolsMock).toHaveBeenCalledTimes(1);
    // Fallback to generateFixed.
    expect(generateFixedMock).toHaveBeenCalledTimes(1);
    // Reflection still completed with a valid patch.
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0].patch.currentTone).toBe('playful');
  });

  it('toolEquipped=false → generateWithTools never called, single-call path used', async () => {
    const { store, applyCalls } = fakeStore({ firstResult: { accepted: true, reflectionId: 103 } });

    const generateWithToolsMock = mock(
      async (): Promise<ToolUseGenerateResponse> => ({
        text: '',
        stopReason: 'end_turn',
        toolCalls: [],
      }),
    );
    const generateFixedMock = mock(async () => ({ text: validFinalJson() }));
    const llmSvc = {
      generateFixed: generateFixedMock,
      generateWithTools: generateWithToolsMock,
    } as unknown as LLMService;

    // toolEquipped=false (default).
    const mindSvc = fakeMindService({ toolEquipped: false, maxToolRounds: 4 });
    const engine = buildEngine({
      store,
      mindSvc,
      llmSvc,
      toolManager: fakeToolManager(),
      hookManager: fakeHookManager(),
    });

    await engine.runReflection({ trigger: 'manual' });

    expect(generateWithToolsMock).not.toHaveBeenCalled();
    expect(generateFixedMock).toHaveBeenCalledTimes(1);
    expect(applyCalls.length).toBe(1);
  });
});
