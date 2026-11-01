// A model only works on the provider it was chosen for, so LLMService routes a provider and
// its model as one target. These tests pin that every route keeps the pair intact: the
// default, a named provider, a session override, a health swap, an unavailable target and a
// tool loop that falls over mid-turn. Provider and model names are synthetic.

import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { AIGenerateOptions, AIGenerateResponse, ToolDefinition } from '@/ai/types';
import { HttpClientError } from '@/api/http/HttpClient';
import type { LLMTarget } from '@/core/config/types/ai';
import { createLLMService, type LLMServiceTestState } from './createLLMService';

interface FakeProvider {
  name: string;
  /** The model each call was sent with. */
  models: Array<string | undefined>;
}

function fakeProvider(
  name: string,
  configuredModel: string,
  respond: (call: number) => AIGenerateResponse | Error = () => ({ text: 'ok' }),
): FakeProvider {
  const models: Array<string | undefined> = [];
  return {
    name,
    models,
    getCapabilities: () => ['llm'],
    isAvailable: () => true,
    supportsToolUse: true,
    getDefaultModel: () => configuredModel,
    generate: async (_prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> => {
      models.push(options?.model);
      const result = respond(models.length);
      if (result instanceof Error) throw result;
      return result;
    },
  } as FakeProvider;
}

function serviceWith(
  providers: FakeProvider[],
  defaultLLM: LLMTarget,
  state: LLMServiceTestState = {},
  fallbackOrder: string[] = [],
) {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const aiManager = {
    getProviderForCapability: (_cap: string, name?: string) => (name ? (byName.get(name) ?? null) : null),
    getProvidersForCapability: () => providers,
    getDefaultLLM: () => defaultLLM,
  } as unknown as AIManager;
  return createLLMService(aiManager, { toolUseProviders: providers.map((p) => p.name), fallback: { fallbackOrder } }, state);
}

const NOOP_TOOL: ToolDefinition = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {} },
};

describe('LLMService targets: a provider and its model travel together', () => {
  it('runs the default LLM on its own model and a named provider on that provider’s model', async () => {
    const shared = fakeProvider('shared', 'shared-large');
    const service = serviceWith([shared], { provider: 'shared', model: 'shared-small' });

    const byDefault = await service.generate('hi', { reasoningEffort: 'none' });
    const byName = await service.generate('hi', { reasoningEffort: 'none' }, { provider: 'shared' });

    expect(shared.models).toEqual(['shared-small', 'shared-large']);
    expect(byDefault.resolvedModel).toBe('shared-small');
    expect(byName.resolvedModel).toBe('shared-large');
  });

  it('runs a session override on its own target instead of the default', async () => {
    const alpha = fakeProvider('alpha', 'alpha-default');
    const beta = fakeProvider('beta', 'beta-default');
    const service = serviceWith(
      [alpha, beta],
      { provider: 'alpha', model: 'alpha-small' },
      { sessionLLM: { provider: 'beta', model: 'beta-pinned' } },
    );

    await service.generate('hi', { reasoningEffort: 'none', sessionId: 'group:10000001' });

    expect(alpha.models).toEqual([]);
    expect(beta.models).toEqual(['beta-pinned']);
  });

  it('swaps an unhealthy default to a fallback provider on that provider’s own model', async () => {
    const alpha = fakeProvider('alpha', 'alpha-default');
    const beta = fakeProvider('beta', 'beta-default');
    const service = serviceWith([alpha, beta], { provider: 'alpha', model: 'alpha-small' }, { unhealthy: ['alpha'] }, [
      'beta',
    ]);

    const res = await service.generate('hi', { reasoningEffort: 'none' });

    expect(alpha.models).toEqual([]);
    expect(beta.models).toEqual(['beta-default']);
    expect(res.resolvedModel).toBe('beta-default');
  });

  it('falls back from an unavailable target to the default LLM without carrying the target’s model', async () => {
    const alpha = fakeProvider('alpha', 'alpha-default');
    const service = serviceWith([alpha], { provider: 'alpha', model: 'alpha-small' });

    await service.generate('hi', { reasoningEffort: 'none' }, { provider: 'missing', model: 'missing-model' });

    expect(alpha.models).toEqual(['alpha-small']);
  });

  it('moves a tool loop to the fallback provider, on that provider’s model, for every later round', async () => {
    const alpha = fakeProvider('alpha', 'alpha-default', () => new HttpClientError('Bad request', 400));
    const beta = fakeProvider('beta', 'beta-default', (call) =>
      call === 1 ? { text: '', functionCalls: [{ name: 'noop', arguments: '{}', toolCallId: 'call_1' }] } : { text: 'done' },
    );
    const service = serviceWith([alpha, beta], { provider: 'alpha', model: 'alpha-small' }, {}, ['beta']);

    const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], [NOOP_TOOL], {
      reasoningEffort: 'none',
      toolExecutor: async () => 'ok',
    });

    expect(alpha.models).toEqual(['alpha-small']);
    expect(beta.models).toEqual(['beta-default', 'beta-default']);
    expect(res.text).toBe('done');
    expect(res.resolvedProviderName).toBe('beta');
  });
});
