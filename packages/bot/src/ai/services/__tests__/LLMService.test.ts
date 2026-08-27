import 'reflect-metadata';

import { describe, expect, it, test } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { AIGenerateOptions, AIGenerateResponse, ToolDefinition } from '@/ai/types';
import { HttpClientError } from '@/api/http/HttpClient';
import { isTransientLLMError, LLMService } from '../LLMService';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
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
      expect(lastOptions?.maxTokens).toBe(TOKEN_BUDGET.decision);
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

describe('LLMService resolvedModel stamping', () => {
  it('falls back to provider.getDefaultModel() when the provider reports no resolvedModel', async () => {
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      generate: async () => ({ text: 'ok' }),
      getDefaultModel: () => 'gpt-4o-mini',
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    const service = new LLMService(aiManager);

    const res = await service.generate('hi', undefined, 'mock');
    expect(res.resolvedModel).toBe('gpt-4o-mini');
  });

  it('prefers the model the provider reports over its configured default', async () => {
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      generate: async () => ({ text: 'ok', resolvedModel: 'gemini-3.5-flash' }),
      getDefaultModel: () => 'gemini-3-flash-preview',
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    const service = new LLMService(aiManager);

    const res = await service.generate('hi', undefined, 'mock');
    expect(res.resolvedModel).toBe('gemini-3.5-flash');
  });

  it('stamps the provider default model on the tool-use path too', async () => {
    const provider = {
      name: 'mock',
      getCapabilities: () => ['llm'],
      isAvailable: () => true,
      supportsToolUse: true,
      generate: async () => ({ text: 'no tools needed' }),
      getDefaultModel: () => 'gpt-4o-mini',
    };
    const aiManager = {
      getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
      getProvidersForCapability: () => [],
      getDefaultProvider: () => provider,
    } as unknown as AIManager;
    const service = new LLMService(aiManager, undefined, undefined, {
      toolUseProviders: ['mock'],
      fallback: { fallbackOrder: [] },
    });

    const tools: ToolDefinition[] = [
      { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } },
    ];
    const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, undefined, 'mock');
    expect(res.resolvedModel).toBe('gpt-4o-mini');
  });

  describe('generateWithTools reasoningContent', () => {
    /** Provider that emits reasoning on every round, calling a tool on all but the last. */
    function createReasoningProvider(toolRounds: number) {
      let round = 0;
      return {
        name: 'mock',
        getCapabilities: () => ['llm'],
        isAvailable: () => true,
        supportsToolUse: true,
        generate: async (): Promise<AIGenerateResponse> => {
          round++;
          if (round <= toolRounds) {
            return {
              text: '',
              reasoningContent: `thinking round ${round}`,
              functionCalls: [{ name: 'noop', arguments: '{}', toolCallId: `call_${round}` }],
            };
          }
          return { text: 'final answer', reasoningContent: `thinking round ${round}` };
        },
      };
    }

    function createService(provider: unknown) {
      const aiManager = {
        getProviderForCapability: (_cap: string, name?: string) => (name ? provider : null),
        getProvidersForCapability: () => [],
        getDefaultProvider: () => provider,
      } as unknown as AIManager;
      return new LLMService(aiManager, undefined, undefined, {
        toolUseProviders: ['mock'],
        fallback: { fallbackOrder: [] },
      });
    }

    const tools: ToolDefinition[] = [
      { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } },
    ];

    it('joins reasoning from every tool round, not just the final one', async () => {
      const service = createService(createReasoningProvider(2));
      const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => 'ok',
      });

      expect(res.text).toBe('final answer');
      expect(res.reasoningContent).toBe('thinking round 1\n\n---\n\nthinking round 2\n\n---\n\nthinking round 3');
    });

    it('reports each round to onReasoning as it lands, in order', async () => {
      const service = createService(createReasoningProvider(2));
      const seen: string[] = [];
      await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => {
          // Records interleaving: a round's thinking must arrive before its tools run.
          seen.push('<tool>');
          return 'ok';
        },
        onReasoning: async (text) => {
          seen.push(text);
        },
      });

      expect(seen).toEqual([
        'thinking round 1',
        '<tool>',
        'thinking round 2',
        '<tool>',
        'thinking round 3',
      ]);
    });

    it('reports identical reasoning only once', async () => {
      let round = 0;
      const provider = {
        name: 'mock',
        getCapabilities: () => ['llm'],
        isAvailable: () => true,
        supportsToolUse: true,
        generate: async (): Promise<AIGenerateResponse> => {
          round++;
          // Same thinking text on both rounds — must not be sent twice.
          return round === 1
            ? {
                text: '',
                reasoningContent: 'same thought',
                functionCalls: [{ name: 'noop', arguments: '{}', toolCallId: 'c1' }],
              }
            : { text: 'done', reasoningContent: 'same thought' };
        },
      };
      const service = createService(provider);
      const emitted: string[] = [];
      const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => 'ok',
        onReasoning: async (text) => {
          emitted.push(text);
        },
      });

      expect(emitted).toEqual(['same thought']);
      expect(res.reasoningContent).toBe('same thought');
    });

    it('reports reasoning on the no-tools short-circuit path', async () => {
      const service = createService(createReasoningProvider(0));
      const emitted: string[] = [];
      await service.generateWithTools([{ role: 'user', content: 'hi' }], [], {
        onReasoning: async (text) => {
          emitted.push(text);
        },
      });

      expect(emitted).toEqual(['thinking round 1']);
    });

    it('survives an onReasoning callback that throws', async () => {
      const service = createService(createReasoningProvider(0));
      const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => 'ok',
        onReasoning: async () => {
          throw new Error('send failed');
        },
      });

      expect(res.text).toBe('final answer');
    });

    it('returns the single round of reasoning when no tool is called', async () => {
      const service = createService(createReasoningProvider(0));
      const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => 'ok',
      });

      expect(res.reasoningContent).toBe('thinking round 1');
    });

    it('leaves reasoningContent undefined for a non-reasoning provider', async () => {
      const provider = {
        name: 'mock',
        getCapabilities: () => ['llm'],
        isAvailable: () => true,
        supportsToolUse: true,
        generate: async (): Promise<AIGenerateResponse> => ({ text: 'plain answer' }),
      };
      const service = createService(provider);
      const res = await service.generateWithTools([{ role: 'user', content: 'hi' }], tools, {
        toolExecutor: async () => 'ok',
      });

      expect(res.reasoningContent).toBeUndefined();
    });
  });
});
