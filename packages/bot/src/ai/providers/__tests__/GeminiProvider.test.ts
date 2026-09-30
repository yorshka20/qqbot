// Tests for GeminiProvider request construction: which model serves a request and
// how the pipeline's reasoning effort maps onto Gemini's thinking controls. The SDK
// client is stubbed via getClient() so no network is hit; each call records the
// model and the thinkingConfig it ran with.

import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { container } from 'tsyringe';
import type { GeminiProviderConfig } from '@/core/config/types/ai';
import type { AIGenerateOptions } from '../../types';
import { GeminiProvider } from '../GeminiProvider';
import { clampMaxTokens } from '../maxTokens';
import { ResourceCleanupService } from '@/services/video/ResourceCleanupService';

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
  thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number; includeThoughts?: boolean };
  maxOutputTokens?: number;
}

/** Stub getClient() to record each generateContent call. */
function installFakeClient(
  provider: GeminiProvider,
  responseParts: Array<{ text?: string; thought?: boolean }> = [{ text: 'hi' }],
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fakeClient = {
    models: {
      generateContent: async (req: {
        model: string;
        config?: { thinkingConfig?: RecordedCall['thinkingConfig']; maxOutputTokens?: number };
      }) => {
        calls.push({
          model: req.model,
          thinkingConfig: req.config?.thinkingConfig,
          maxOutputTokens: req.config?.maxOutputTokens,
        });
        return {
          candidates: [{ content: { parts: responseParts }, finishReason: 'STOP' }],
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
    container.register(ResourceCleanupService, {
      useValue: { registerFileCleanup: () => {} } as unknown as ResourceCleanupService,
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
    container.register(ResourceCleanupService, {
      useValue: { registerFileCleanup: () => {} } as unknown as ResourceCleanupService,
    });
  });

  const cases: Array<[NonNullable<AIGenerateOptions['reasoningEffort']>, RecordedCall['thinkingConfig']]> = [
    ['none', { thinkingLevel: 'MINIMAL', includeThoughts: true }],
    ['minimal', { thinkingLevel: 'MINIMAL', includeThoughts: true }],
    ['low', { thinkingLevel: 'LOW', includeThoughts: true }],
    ['medium', { thinkingLevel: 'MEDIUM', includeThoughts: true }],
    ['high', { thinkingLevel: 'HIGH', includeThoughts: true }],
  ];

  for (const [effort, expected] of cases) {
    it(`maps reasoningEffort=${effort} to ${JSON.stringify(expected)}`, async () => {
      const provider = new GeminiProvider(baseConfig());
      const calls = installFakeClient(provider);

      await provider.generate('hi', { ...promptOpts, reasoningEffort: effort });

      expect(calls[0].thinkingConfig).toEqual(expected);
    });
  }

  // Levels a model does not take are a 400, so the provider sends the nearest one the model accepts.
  const perModelCases: Array<[string, NonNullable<AIGenerateOptions['reasoningEffort']>, string]> = [
    ['gemini-3.8-flash', 'minimal', 'LOW'],
    ['gemini-3.8-flash', 'none', 'LOW'],
    ['gemini-3.5-flash-lite', 'none', 'MINIMAL'],
    ['gemini-3-pro-preview', 'medium', 'HIGH'],
    ['gemini-3.1-flash-lite-image', 'low', 'HIGH'],
  ];

  for (const [model, effort, level] of perModelCases) {
    it(`sends ${model} a level it accepts for reasoningEffort=${effort} (${level})`, async () => {
      const provider = new GeminiProvider(baseConfig());
      const calls = installFakeClient(provider);

      await provider.generate('hi', { ...promptOpts, model, reasoningEffort: effort });

      expect(calls[0].thinkingConfig).toEqual({ thinkingLevel: level, includeThoughts: true });
    });
  }

  it('leaves the level to a model missing from the table, since only its default is sure to be accepted', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    await provider.generate('hi', { ...promptOpts, model: 'gemini-9-unlisted', reasoningEffort: 'minimal' });

    expect(calls[0].thinkingConfig).toEqual({ includeThoughts: true });
  });

  it('keeps every table row ascending, which the nearest-level-above lookup relies on', () => {
    const statics = GeminiProvider as unknown as {
      THINKING_LEVELS_ASCENDING: readonly string[];
      MODEL_THINKING_LEVELS: Record<string, readonly string[]>;
    };
    for (const levels of Object.values(statics.MODEL_THINKING_LEVELS)) {
      const ranks = levels.map((level) => statics.THINKING_LEVELS_ASCENDING.indexOf(level));
      expect(ranks.length).toBeGreaterThan(0);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(ranks.every((rank) => rank >= 0)).toBe(true);
    }
  });

  it('requests only thought summaries when no effort is given, leaving the thinking level to the model', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    await provider.generate('hi', promptOpts);

    expect(calls[0].thinkingConfig).toEqual({ includeThoughts: true });
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

describe('GeminiProvider thought parts → reasoningContent', () => {
  beforeEach(() => {
    container.register(ResourceCleanupService, {
      useValue: { registerFileCleanup: () => {} } as unknown as ResourceCleanupService,
    });
  });

  it('splits thought parts into reasoningContent and keeps them out of text', async () => {
    const provider = new GeminiProvider(baseConfig());
    installFakeClient(provider, [
      { text: 'pondering…', thought: true },
      { text: 'hello' },
    ]);

    const res = await provider.generate('hi', promptOpts);

    expect(res.text).toBe('hello');
    expect(res.reasoningContent).toBe('pondering…');
  });

  it('leaves reasoningContent undefined when the response has no thought parts', async () => {
    const provider = new GeminiProvider(baseConfig());
    installFakeClient(provider);

    const res = await provider.generate('hi', promptOpts);

    expect(res.reasoningContent).toBeUndefined();
  });
});

describe('GeminiProvider output budget', () => {
  beforeEach(() => {
    container.register(ResourceCleanupService, {
      useValue: { registerFileCleanup: () => {} } as unknown as ResourceCleanupService,
    });
  });

  it('sends the ceiling when neither the call nor the config sets a budget', async () => {
    const config = baseConfig();
    config.llm = { ...config.llm, maxTokens: undefined } as GeminiProviderConfig['llm'];
    const provider = new GeminiProvider(config);
    const calls = installFakeClient(provider);

    await provider.generate('hi', { ...promptOpts, reasoningEffort: 'low' });

    expect(calls[0].maxOutputTokens).toBe(clampMaxTokens(undefined));
  });
});
