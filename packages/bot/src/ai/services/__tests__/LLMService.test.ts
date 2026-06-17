import 'reflect-metadata';

import { describe, expect, it, test } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { AIGenerateOptions, AIGenerateResponse } from '@/ai/types';
import { HttpClientError } from '@/api/http/HttpClient';
import { isTransientLLMError, LLMService } from '../LLMService';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TEST_TIMEOUT_MS,
} from './integrationTestHelpers';

function createMockAIManager(): AIManager {
  return {
    getProviderForCapability: () => null,
    getDefaultProvider: () => null,
  } as unknown as AIManager;
}

describe('LLMService', () => {
  describe('providerSupportsToolUse', () => {
    const service = new LLMService(createMockAIManager(), undefined, undefined, {
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
      const noConfigService = new LLMService(createMockAIManager());
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
      const llmService = new LLMService(aiManager);

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
      'generate with messages returns text',
      async () => {
        const messages = [{ role: 'user' as const, content: 'Reply with only the number 42.' }];
        const res = await llmService.generate('Reply with only the number 42.', { messages }, 'doubao');
        expect(res).toBeDefined();
        expect(typeof res.text).toBe('string');
        expect(res.text.length).toBeGreaterThan(0);
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    );
  });
});

describe('isTransientLLMError', () => {
  it('retries on rate-limit and server-side HTTP statuses (incl. 529)', () => {
    for (const status of [429, 500, 502, 503, 529, 599]) {
      expect(isTransientLLMError(new HttpClientError('boom', status))).toBe(true);
    }
  });

  it('does not retry on non-429 client errors', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientLLMError(new HttpClientError('nope', status))).toBe(false);
    }
  });

  it('uses status over message text: Anthropic 529 body reads only "Overloaded"', () => {
    // The status drives the decision; the body has no code to regex-match.
    expect(isTransientLLMError(new HttpClientError('Overloaded', 529))).toBe(true);
    // Same wording with no status would not be caught by the message patterns.
    expect(isTransientLLMError(new Error('Overloaded'))).toBe(false);
  });

  it('falls back to message patterns for status-less errors', () => {
    expect(isTransientLLMError(new Error('socket hang up'))).toBe(true);
    expect(isTransientLLMError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientLLMError(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransientLLMError(new Error('Failed to parse JSON response'))).toBe(true);
    expect(isTransientLLMError(new Error('some random validation error'))).toBe(false);
  });

  it('treats hard timeouts as transient only when retryOnTimeout is set', () => {
    const timeout = new Error('Request timeout after 90000ms');
    expect(isTransientLLMError(timeout)).toBe(false);
    expect(isTransientLLMError(timeout, { retryOnTimeout: true })).toBe(true);
  });
});

describe('LLMService same-provider retry', () => {
  function makeService(generate: (p: string, o?: Record<string, unknown>) => Promise<AIGenerateResponse>) {
    let calls = 0;
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      generate: (p: string, o?: Record<string, unknown>) => {
        calls++;
        return generate(p, o);
      },
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    return { service: new LLMService(aiManager), getCalls: () => calls };
  }

  it('retries a transient 529 then returns the successful response (with resolvedModel)', async () => {
    let n = 0;
    const { service, getCalls } = makeService(async () => {
      n++;
      if (n === 1) throw new HttpClientError('Overloaded', 529);
      return { text: 'ok', resolvedModel: 'gemini-3.5-flash' };
    });
    const res = await service.generate('hi', undefined, 'mock');
    expect(res.text).toBe('ok');
    expect(res.resolvedModel).toBe('gemini-3.5-flash');
    expect(getCalls()).toBe(2);
  }, 20_000);

  it('does not retry a non-transient 404 (no fallback provider configured → fallback response)', async () => {
    const { service, getCalls } = makeService(async () => {
      throw new HttpClientError('not found', 404);
    });
    const res = await service.generate('hi', undefined, 'mock');
    // No same-provider retry, no alternative provider → graceful fallback text.
    expect(getCalls()).toBe(1);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

describe('LLMService trace observers', () => {
  it('emits a trace entry for each generate() call with prompt, messages and response', async () => {
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      generate: async () => ({
        text: 'hello back',
        resolvedModel: 'mock-1',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      }),
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    const service = new LLMService(aiManager);

    const seen: import('@/ai/types').LLMTraceEntry[] = [];
    service.addTraceObserver((e) => seen.push(e));

    await service.generate('ask', { messages: [{ role: 'user', content: 'ask' }], systemPrompt: 'sys' }, 'mock');

    expect(seen.length).toBe(1);
    expect(seen[0].opLabel).toBe('generate');
    expect(seen[0].provider).toBe('mock');
    expect(seen[0].resolvedModel).toBe('mock-1');
    expect(seen[0].systemPrompt).toBe('sys');
    expect(seen[0].messages?.[0]?.content).toBe('ask');
    expect(seen[0].response.text).toBe('hello back');
    expect(seen[0].response.usage?.totalTokens).toBe(5);
  });

  it('a throwing observer never breaks generation', async () => {
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      generate: async () => ({ text: 'ok' }),
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    const service = new LLMService(aiManager);
    service.addTraceObserver(() => {
      throw new Error('observer boom');
    });

    const res = await service.generate('hi', undefined, 'mock');
    expect(res.text).toBe('ok');
  });
});
