import 'reflect-metadata';

import { describe, expect, it, vi } from 'bun:test';
import type { AIManager, AIProvider } from '@qqbot/llm';
import type { ProviderSelector } from '@/ai/ProviderSelector';
import type { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { VisionService } from '../VisionService';

const USAGE = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 };

function makeService(response: { text: string; usage?: typeof USAGE; resolvedModel?: string }) {
  const provider = {
    name: 'gemini',
    getCapabilities: () => ['vision'],
    isAvailable: () => true,
    generateWithVisionMessages: vi.fn(async () => response),
  } as unknown as AIProvider;
  const aiManager = {
    getDefaultProvider: () => provider,
    getProviderForCapability: () => provider,
  } as unknown as AIManager;
  const selector = { getSessionOverride: async () => null } as unknown as ProviderSelector;
  const tokenUsage = { recordSystemLLM: vi.fn(async () => null) };
  const service = new VisionService(aiManager, selector, tokenUsage as unknown as TokenUsageService);
  return { service, tokenUsage };
}

const OPTIONS = { reasoningEffort: 'low' as const };

describe('VisionService usage', () => {
  it('records a vision call as system usage', async () => {
    const { service, tokenUsage } = makeService({ text: 'ok', usage: USAGE, resolvedModel: 'vision-model' });

    await service.generateWithVisionMessages([{ role: 'user', content: 'hi' }], OPTIONS);

    expect(tokenUsage.recordSystemLLM).toHaveBeenCalledWith({
      provider: 'gemini',
      model: 'vision-model',
      usage: USAGE,
    });
  });

  it('records nothing when the response reports no usage', async () => {
    const { service, tokenUsage } = makeService({ text: 'ok' });

    await service.generateWithVisionMessages([{ role: 'user', content: 'hi' }], OPTIONS);

    expect(tokenUsage.recordSystemLLM).not.toHaveBeenCalled();
  });
});
