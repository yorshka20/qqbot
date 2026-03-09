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
    const service = new LLMService(createMockAIManager());
    const svc = service as unknown as { providerSupportsToolUse(name: string): boolean };

    it('returns true for openai, anthropic, doubao, gemini, deepseek', () => {
      expect(svc.providerSupportsToolUse('openai')).toBe(true);
      expect(svc.providerSupportsToolUse('anthropic')).toBe(true);
      expect(svc.providerSupportsToolUse('doubao')).toBe(true);
      expect(svc.providerSupportsToolUse('gemini')).toBe(true);
      expect(svc.providerSupportsToolUse('deepseek')).toBe(true);
    });

    it('returns true for provider names in lowercase', () => {
      expect(svc.providerSupportsToolUse('OPENAI')).toBe(true);
      expect(svc.providerSupportsToolUse('DeepSeek')).toBe(true);
    });

    it('returns false for unknown provider', () => {
      expect(svc.providerSupportsToolUse('ollama')).toBe(false);
      expect(svc.providerSupportsToolUse('unknown')).toBe(false);
      expect(svc.providerSupportsToolUse('')).toBe(false);
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
      const llmService = new LLMService(aiManager);

      await llmService.generateLite('test prompt');
      expect(lastOptions).toBeDefined();
      expect(lastOptions?.temperature).toBe(0.1);
      expect(lastOptions?.maxTokens).toBe(256);
      expect(lastOptions?.reasoningEffort).toBe('minimal');

      await llmService.generateLite('test', undefined, 'mock', 'doubao-1-5-lite-32k-250115');
      expect(lastOptions?.model).toBe('doubao-1-5-lite-32k-250115');
    });

    it('returns fallback when no provider available', async () => {
      const aiManager = createMockAIManager();
      const llmService = new LLMService(aiManager);
      const res = await llmService.generateLite('hello', undefined, 'nonexistent');
      expect(res.text).toContain('unavailable');
    });
  });

  // Integration: real LLM API calls when provider is configured (CONFIG_PATH / config.jsonc).
  describe.skipIf(!getIntegrationProvider('doubao'))('integration (real API)', () => {
    const aiManager = createAIManagerWithProvider('doubao');
    const llmService = new LLMService(aiManager);

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
