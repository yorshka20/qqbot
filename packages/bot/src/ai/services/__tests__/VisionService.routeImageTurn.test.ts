import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { AIProvider } from '@/ai/base/AIProvider';
import type { CapabilityType } from '@/ai/capabilities/types';
import type { LLMCapability } from '@/ai/capabilities/LLMCapability';
import { VisionService } from '../VisionService';

function providerWith(name: string, capabilities: CapabilityType[]): AIProvider {
  return {
    name,
    getCapabilities: () => capabilities,
    isAvailable: () => true,
  } as unknown as AIProvider;
}

/** AIManager stub whose only vision provider is the configured default. */
function managerWithVisionDefault(visionDefault: AIProvider | null): AIManager {
  return {
    getDefaultProvider: (capability: CapabilityType) => (capability === 'vision' ? visionDefault : null),
    getProviderForCapability: (capability: CapabilityType, providerName?: string) =>
      capability === 'vision' && providerName === visionDefault?.name ? visionDefault : null,
  } as unknown as AIManager;
}

const geminiVision = providerWith('gemini', ['llm', 'vision']);

describe('VisionService.routeImageTurn', () => {
  it('keeps the turn on the answering provider when it can see images', async () => {
    const service = new VisionService(managerWithVisionDefault(geminiVision));
    const deepseek = providerWith('deepseek', ['llm', 'function_calling', 'vision']) as unknown as LLMCapability;

    const routing = await service.routeImageTurn(deepseek, undefined, 'group:10000001');

    // undefined = the default provider keeps the turn, no swap to the vision default
    expect(routing.providerName).toBeUndefined();
    expect(routing.canSeeImages).toBe(true);
  });

  it('keeps an explicitly routed provider that can see images', async () => {
    const service = new VisionService(managerWithVisionDefault(geminiVision));
    const doubao = providerWith('doubao', ['llm', 'vision']) as unknown as LLMCapability;

    const routing = await service.routeImageTurn(doubao, 'doubao', 'group:10000001');

    expect(routing.providerName).toBe('doubao');
    expect(routing.canSeeImages).toBe(true);
  });

  it('hands the turn to the configured vision provider when the answering one is text-only', async () => {
    const service = new VisionService(managerWithVisionDefault(geminiVision));
    const ollama = providerWith('ollama', ['llm']) as unknown as LLMCapability;

    const routing = await service.routeImageTurn(ollama, 'ollama', 'group:10000001');

    expect(routing.providerName).toBe('gemini');
    expect(routing.canSeeImages).toBe(true);
  });

  it('leaves the turn put when no vision provider is configured at all', async () => {
    const service = new VisionService(managerWithVisionDefault(null));
    const ollama = providerWith('ollama', ['llm']) as unknown as LLMCapability;

    const routing = await service.routeImageTurn(ollama, 'ollama', 'group:10000001');

    expect(routing.providerName).toBe('ollama');
    expect(routing.canSeeImages).toBe(false);
  });
});
