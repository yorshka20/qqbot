import { describe, expect, it, test } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { AIGenerateOptions } from '@/ai/types';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TEST_TIMEOUT_MS,
} from '../integrationTestHelpers';
import { LLMService } from '../LLMService';

function createMockAIManager(): AIManager {
  return {
    getProviderForCapability: () => null,
    getDefaultProvider: () => null,
  } as unknown as AIManager;
}

describe('LLMService', () => {
  describe('providerSupportsToolUse', () => {
    const service = LLMService.create(createMockAIManager(), undefined, undefined, {
      toolUseProviders: ['openai', 'anthropic', 'doubao', 'gemini', 'deepseek'],
      fallback: { fallbackOrder: [] },
    });

    it('returns true for configured providers', () => {
      expect(service.providerSupportsToolUse('openai')).toBe(true);
      expect(service.providerSupportsToolUse('anthropic')).toBe(true);
      expect(service.providerSupportsToolUse('doubao')).toBe(true);
      expect(service.providerSupportsToolUse('gemini')).toBe(true);
      expect(service.providerSupportsToolUse('deepseek')).toBe(true);
    });

    it('returns true for provider names in any case', () => {
      expect(service.providerSupportsToolUse('OPENAI')).toBe(true);
      expect(service.providerSupportsToolUse('DeepSeek')).toBe(true);
    });

    it('returns false for unconfigured provider', () => {
      expect(service.providerSupportsToolUse('ollama')).toBe(false);
      expect(service.providerSupportsToolUse('unknown')).toBe(false);
      expect(service.providerSupportsToolUse('')).toBe(false);
    });

    it('returns false for all providers when no config provided', () => {
      const noConfigService = LLMService.create(createMockAIManager());
      expect(noConfigService.providerSupportsToolUse('openai')).toBe(false);
    });
  });

  describe('generateLite', () => {
    it('calls provider.generate with lite defaults and optional provider/model', async () => {
      let lastOptions: AIGenerateOptions | undefined;
      const mockProvider = {
        name: 'mock',
        getCapabilities: () => ['llm'],
        isAvailable: () => true,
        generate: async (_prompt: string, options?: Record<string, unknown>) => {
          lastOptions = options;
          return { text: '{"result": "ok"}' };
        },
      };
      const aiManager = {
        getProviderForCapability: (_cap: string, name?: string) => (name ? mockProvider : null),
        getDefaultProvider: () => mockProvider,
      } as unknown as AIManager;
      const llmService = LLMService.create(aiManager);

      await llmService.generateLite('test prompt');
      expect(lastOptions).toBeDefined();
      expect(lastOptions?.temperature).toBe(0.1);
      expect(lastOptions?.maxTokens).toBe(256);
      expect(lastOptions?.reasoningEffort).toBe('minimal');

      await llmService.generateLite('test', { model: 'doubao-1-5-lite-32k-250115' }, 'doubao');
      expect(lastOptions?.model).toBe('doubao-1-5-lite-32k-250115');
    });

    it('returns fallback when no provider available', async () => {
      const aiManager = createMockAIManager();
      const llmService = LLMService.create(aiManager);
      const res = await llmService.generateLite('hello', undefined, 'nonexistent');
      expect(res.text).toContain('unavailable');
    });
  });

  // Integration: real LLM API calls when provider is configured (CONFIG_PATH / config.jsonc).
  describe.skipIf(!getIntegrationProvider('doubao'))('integration (real API)', () => {
    const aiManager = createAIManagerWithProvider('doubao');
    const llmService = LLMService.create(aiManager);

    test(
      'generate returns text and optional usage',
      async () => {
        const res = await llmService.generate('Say "hello" in one short word.', undefined, 'doubao');
        expect(res).toBeDefined();
        expect(typeof res.text).toBe('string');
        expect(res.text.length).toBeGreaterThan(0);
        if (res.usage) {
          expect(res.usage.promptTokens).toBeGreaterThanOrEqual(0);
          expect(res.usage.completionTokens).toBeGreaterThanOrEqual(0);
        }
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    );

    test(
      'generateMessages returns text',
      async () => {
        const messages = [{ role: 'user' as const, content: 'Reply with only the number 42.' }];
        const res = await llmService.generateMessages(messages, {}, 'doubao');
        expect(res).toBeDefined();
        expect(typeof res.text).toBe('string');
        expect(res.text.length).toBeGreaterThan(0);
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    );
  });
});
