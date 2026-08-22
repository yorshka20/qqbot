// Tests for GeminiProvider request construction: which model serves a request and
// how the pipeline's reasoning effort maps onto Gemini's thinking controls. The SDK
// client is stubbed via getClient() so no network is hit; each call records the
// model and the thinkingConfig it ran with.

import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { container } from 'tsyringe';
import type { GeminiProviderConfig } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import type { AIGenerateOptions } from '../types';
import { GeminiProvider } from './GeminiProvider';

function baseConfig(): GeminiProviderConfig {
  return {
    type: 'gemini',
    apiKey: 'test-key',
    llm: {
      model: 'gemini-3-flash-preview',
      temperature: 0.4,
      maxTokens: 100,
    },
  } as GeminiProviderConfig;
}

interface RecordedCall {
  model: string;
  thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number };
}

/** Stub getClient() to record each generateContent call. */
function installFakeClient(provider: GeminiProvider): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fakeClient = {
    models: {
      generateContent: async (req: { model: string; config?: { thinkingConfig?: RecordedCall['thinkingConfig'] } }) => {
        calls.push({ model: req.model, thinkingConfig: req.config?.thinkingConfig });
        return {
          candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          text: 'hi',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
      },
    },
  };
  (provider as unknown as { getClient: () => unknown }).getClient = () => fakeClient;
  return calls;
}

const promptOpts = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('GeminiProvider model resolution', () => {
  beforeEach(() => {
    container.register(DITokens.RESOURCE_CLEANUP_SERVICE, {
      useValue: { registerFileCleanup: () => {} },
    });
  });

  it('uses the configured llm model and reports it as resolvedModel', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    const res = await provider.generate('hi', promptOpts);

    expect(res.resolvedModel).toBe('gemini-3-flash-preview');
    expect(calls.map((c) => c.model)).toEqual(['gemini-3-flash-preview']);
  });

  it('a caller-pinned model overrides config and is reported back', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    const res = await provider.generate('hi', { ...promptOpts, model: 'gemini-3-pro' });

    expect(res.resolvedModel).toBe('gemini-3-pro');
    expect(calls.map((c) => c.model)).toEqual(['gemini-3-pro']);
  });
});

describe('GeminiProvider reasoning effort → thinkingConfig', () => {
  beforeEach(() => {
    container.register(DITokens.RESOURCE_CLEANUP_SERVICE, {
      useValue: { registerFileCleanup: () => {} },
    });
  });

  const cases: Array<[NonNullable<AIGenerateOptions['reasoningEffort']>, RecordedCall['thinkingConfig']]> = [
    ['none', { thinkingBudget: 0 }],
    ['minimal', { thinkingLevel: 'MINIMAL' }],
    ['low', { thinkingLevel: 'LOW' }],
    ['medium', { thinkingLevel: 'MEDIUM' }],
    ['high', { thinkingLevel: 'HIGH' }],
  ];

  for (const [effort, expected] of cases) {
    it(`maps reasoningEffort=${effort} to ${JSON.stringify(expected)}`, async () => {
      const provider = new GeminiProvider(baseConfig());
      const calls = installFakeClient(provider);

      await provider.generate('hi', { ...promptOpts, reasoningEffort: effort });

      expect(calls[0].thinkingConfig).toEqual(expected);
    });
  }

  it('omits thinkingConfig when no effort is requested, leaving the model default', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    await provider.generate('hi', promptOpts);

    expect(calls[0].thinkingConfig).toBeUndefined();
  });

  it('unsigned tool_calls in history force thinking off, overriding the requested effort', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    // A tool_call with no thought_signature comes from a non-Gemini provider during
    // fallback; Gemini rejects the request unless thinking is disabled outright.
    await provider.generate('hi', {
      reasoningEffort: 'high',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'search', arguments: '{}' }],
        },
        { role: 'tool', content: 'result', tool_call_id: 'c1' },
      ],
    });

    expect(calls[0].thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});
