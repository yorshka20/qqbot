import 'reflect-metadata';

import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import type { PromptInjectionContext } from '@/conversation/promptInjection/types';
import { createPersonaPromptInjectionProducer, type PersonaServiceLike } from '../prompt/promptInjectionProducer';
import { DEFAULT_PERSONA_CONFIG, type PersonaConfig } from '../types';

// Stub logger
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

function makeCtx(source: PromptInjectionContext['source'], userId?: string): PromptInjectionContext {
  return {
    source,
    userId,
    hookContext: { source } as any,
  };
}

function makePersonaService(overrides: Partial<PersonaServiceLike> = {}): PersonaServiceLike {
  return {
    isEnabled: () => true,
    getPromptPatchFragmentAsync: async () => 'persona fragment',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PersonaConfig['promptPatch']> = {}): PersonaConfig {
  return {
    ...DEFAULT_PERSONA_CONFIG,
    enabled: true,
    promptPatch: {
      ...DEFAULT_PERSONA_CONFIG.promptPatch,
      enabled: true,
      ...overrides,
    },
  };
}

describe('createPersonaPromptInjectionProducer', () => {
  it('case 1: mind disabled → produce returns null', async () => {
    const personaService = makePersonaService({ isEnabled: () => false });
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig() });
    const result = await producer.produce(makeCtx('qq-private', 'u1'));
    expect(result).toBeNull();
  });

  it('case 2: promptPatch.enabled=false → produce returns null', async () => {
    const personaService = makePersonaService();
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig({ enabled: false }) });
    const result = await producer.produce(makeCtx('qq-private', 'u1'));
    expect(result).toBeNull();
  });

  it('case 3: mind enabled + fragment for qq-private → returns { producerName, priority, fragment }', async () => {
    const personaService = makePersonaService({ getPromptPatchFragmentAsync: async () => 'mood: calm' });
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig() });
    const result = await producer.produce(makeCtx('qq-private', 'u1'));
    expect(result).not.toBeNull();
    expect(result?.producerName).toBe('persona');
    expect(result?.priority).toBe(10);
    expect(result?.fragment).toBe('mood: calm');
  });

  it('case 4 (critical): source=avatar-cmd → produce still returns fragment (source check is registry job)', async () => {
    const personaService = makePersonaService({ getPromptPatchFragmentAsync: async () => 'mood: calm' });
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig() });
    const result = await producer.produce(makeCtx('avatar-cmd', 'u1'));
    expect(result).not.toBeNull();
    expect(result?.fragment).toBe('mood: calm');
  });

  it('case 5: user configured applicableSources: [qq-private] → producer.applicableSources strictly matches', () => {
    const personaService = makePersonaService();
    const config = makeConfig({ applicableSources: ['qq-private'] as const });
    const producer = createPersonaPromptInjectionProducer({ personaService, config });
    expect(producer.applicableSources).toStrictEqual(['qq-private']);
    expect(producer.applicableSources).not.toContain('avatar-cmd');
    expect(producer.applicableSources).not.toContain('bilibili-danmaku');
  });

  it('case 6: getPromptPatchFragmentAsync returns empty string → produce returns null', async () => {
    const personaService = makePersonaService({ getPromptPatchFragmentAsync: async () => '' });
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig() });
    const result = await producer.produce(makeCtx('qq-private', 'u1'));
    expect(result).toBeNull();
  });

  it('case 7: default applicableSources covers qq-private, qq-group, avatar-cmd, bilibili-danmaku', () => {
    const personaService = makePersonaService();
    const producer = createPersonaPromptInjectionProducer({ personaService, config: makeConfig() });
    // config.promptPatch.applicableSources is undefined → falls back to built-in fallback
    expect(producer.applicableSources).toContain('qq-private');
    expect(producer.applicableSources).toContain('qq-group');
    expect(producer.applicableSources).toContain('avatar-cmd');
    expect(producer.applicableSources).toContain('bilibili-danmaku');
  });
});

describe('createPersonaPromptInjectionProducer — registry integration', () => {
  let registry: PromptInjectionRegistry;

  beforeEach(() => {
    registry = new PromptInjectionRegistry();
  });

  it('produce NOT invoked when source not in applicableSources', async () => {
    const produceFn = vi.fn(async () => ({ producerName: 'persona', priority: 10, fragment: 'should not appear' }));
    const personaService: PersonaServiceLike = {
      isEnabled: () => true,
      getPromptPatchFragmentAsync: produceFn as any,
    };
    const config = makeConfig({ applicableSources: ['qq-private'] as const });
    const producer = createPersonaPromptInjectionProducer({ personaService, config });
    registry.register(producer);

    const layered = await registry.gatherByLayer(makeCtx('avatar-cmd', 'u1'));
    const results = [...layered.baseline, ...layered.scene, ...layered.runtime, ...layered.tool];
    expect(results).toHaveLength(0);
    // produceFn should NOT have been called — registry filtered by applicableSources
    expect(produceFn).not.toHaveBeenCalled();
  });
});
