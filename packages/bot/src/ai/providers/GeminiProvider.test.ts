// Tests for GeminiProvider model/key resolution: which model and which key (free vs
// paid) actually serve a request, and that the chosen model is reported back as
// `resolvedModel`. The SDK client is stubbed via getClient() so no network is hit;
// each call records the model + the runtime key mode it ran under.

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { container } from 'tsyringe';
import type { GeminiProviderConfig } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import { GeminiProvider } from './GeminiProvider';

function baseConfig(): GeminiProviderConfig {
  return {
    type: 'gemini',
    apiKeyFree: 'free-key',
    apiKeyPaid: 'paid-key',
    llm: {
      model: 'gemini-3-flash-preview',
      paidModel: 'gemini-3.5-flash',
      temperature: 0.4,
      maxTokens: 100,
    },
  } as GeminiProviderConfig;
}

interface RecordedCall {
  model: string;
  keyMode: string;
}

/** Stub getClient() to record each generateContent call; optionally fail the first one. */
function installFakeClient(provider: GeminiProvider, opts: { failFirst?: boolean } = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let n = 0;
  const fakeClient = {
    models: {
      generateContent: async (req: { model: string }) => {
        n++;
        calls.push({ model: req.model, keyMode: GeminiProvider.getKeyMode() });
        if (opts.failFirst && n === 1) {
          throw new Error('429 RESOURCE_EXHAUSTED: quota exhausted');
        }
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

describe('GeminiProvider model/key resolution', () => {
  beforeEach(() => {
    container.register(DITokens.RESOURCE_CLEANUP_SERVICE, {
      useValue: { registerFileCleanup: () => {} },
    });
    GeminiProvider.setKeyMode('free');
  });

  afterEach(() => {
    GeminiProvider.setKeyMode('free');
  });

  it('free success → resolvedModel is the base model on the free key', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    const res = await provider.generate('hi', promptOpts);

    expect(res.resolvedModel).toBe('gemini-3-flash-preview');
    expect(calls).toEqual([{ model: 'gemini-3-flash-preview', keyMode: 'free' }]);
  });

  it('free quota exhausted → falls back to paid key + paidModel', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider, { failFirst: true });

    const res = await provider.generate('hi', promptOpts);

    expect(res.resolvedModel).toBe('gemini-3.5-flash');
    expect(calls).toEqual([
      { model: 'gemini-3-flash-preview', keyMode: 'free' },
      { model: 'gemini-3.5-flash', keyMode: 'paid' },
    ]);
  });

  it('preferPaidTier → paid key + paidModel from the start, no free round-trip', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider);

    const res = await provider.generate('hi', { ...promptOpts, preferPaidTier: true });

    expect(res.resolvedModel).toBe('gemini-3.5-flash');
    expect(calls).toEqual([{ model: 'gemini-3.5-flash', keyMode: 'paid' }]);
  });

  it('caller-pinned model suppresses paidModel escalation, even on the paid retry', async () => {
    const provider = new GeminiProvider(baseConfig());
    const calls = installFakeClient(provider, { failFirst: true });

    const res = await provider.generate('hi', { ...promptOpts, model: 'gemini-3-flash-preview' });

    expect(res.resolvedModel).toBe('gemini-3-flash-preview');
    expect(calls.map((c) => c.model)).toEqual(['gemini-3-flash-preview', 'gemini-3-flash-preview']);
    expect(calls[1].keyMode).toBe('paid');
  });
});
