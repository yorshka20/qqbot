/**
 * LLM integration tests: real API calls to Doubao and DeepSeek.
 * Uses config.jsonc (or CONFIG_PATH) and ProviderFactory; skips when provider is not configured or has no apiKey.
 *
 * Run: bun test src/ai/services/LLMIntegration.test.ts
 * Run one test (use substring): bun test src/ai/services/LLMIntegration.test.ts -t "generate returns text"
 *
 * --- What each test does (call flow) ---
 *
 * 1) "generate returns text and optional usage"
 *    Flow: LLMService.generate(prompt) → AIManager.getAvailableProvider('doubao'|'deepseek') → provider.generate()
 *    → HTTP POST to provider API with single user message → parse response.text + response.usage.
 *    Purpose: Check that a simple one-shot completion works and we get text + optional token usage.
 *
 * 2) "generate with messages returns text"
 *    Flow: LLMService.generateMessages(messages) → same as above but request body is ChatMessage[] (e.g. [user]).
 *    Purpose: Check that message-based API path works (used by tool-use and multi-turn).
 *
 * 3) "generate with tools: response has text or functionCall and parsed tool_call"
 *    Flow: LLMService.generate('', { messages, tools }) → provider receives messages + tools (get_weather, search)
 *    → API may return either plain text or tool_calls (function name + arguments + id). We parse functionCall + toolCallId.
 *    Purpose: Check that when we send tools, the provider returns either text or a valid tool call we can parse.
 *
 * 4) "generateWithTools full round-trip: tool call then executor result returned"
 *    Flow: LLMService.generateWithTools(messages, tools, { toolExecutor }) → in a loop:
 *    (a) generate with current messages + tools;
 *    (b) if response.functionCall: call toolExecutor(functionCall), append tool result to messages, repeat;
 *    (c) if no functionCall: return final response (stopReason 'end_turn').
 *    Purpose: Check full tool-use loop: model calls get_weather → we execute it → send result back → get final reply.
 */
import 'reflect-metadata';

import { describe, expect, test } from 'bun:test';
import { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, FunctionCall } from '@/ai/types';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TEST_TIMEOUT_MS,
  INTEGRATION_TOOL_USE_TIMEOUT_MS,
  SAMPLE_TOOLS,
} from '../integrationTestHelpers';

const LOG_PREFIX = '[LLMIntegration]';

function logFlow(msg: string, data?: Record<string, unknown>): void {
  if (data !== undefined) {
    console.log(LOG_PREFIX, msg, data);
  } else {
    console.log(LOG_PREFIX, msg);
  }
}

describe.skipIf(!getIntegrationProvider('doubao'))('Doubao LLM integration (real API)', () => {
  const aiManager = createAIManagerWithProvider('doubao');
  const llmService = new LLMService(aiManager);
  const providerName = 'doubao';

  test(
    'generate returns text and optional usage',
    async () => {
      const prompt = 'Say "hello" in one short word.';
      logFlow(`[${providerName}] 1) Calling LLMService.generate`, { prompt });
      const res = await llmService.generate(prompt, undefined, providerName);
      logFlow(`[${providerName}] 1) Response`, {
        textPreview: res.text?.slice(0, 80),
        textLength: res.text?.length,
        usage: res.usage,
      });
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

  test('generate with messages returns text', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with only the number 42.' }];
    logFlow(`[${providerName}] 2) Calling LLMService.generateMessages`, { messageCount: messages.length });
    const res = await llmService.generateMessages(messages, {}, providerName);
    logFlow(`[${providerName}] 2) Response`, { textPreview: res.text?.slice(0, 80), textLength: res.text?.length });
    expect(res).toBeDefined();
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
  });

  test(
    'generate with tools: response has text or functionCall and parsed tool_call',
    async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'What is the weather in Beijing right now? Use the get_weather tool.' },
      ];
      logFlow(`[${providerName}] 3) Calling LLMService.generate with messages + tools`, {
        messageCount: messages.length,
        toolNames: SAMPLE_TOOLS.map((t) => t.name),
      });
      const res = await llmService.generate('', { messages, tools: SAMPLE_TOOLS, maxTokens: 1024 }, providerName);
      logFlow(`[${providerName}] 3) Response`, {
        textPreview: res.text?.slice(0, 80),
        functionCall: res.functionCall
          ? { name: res.functionCall.name, argsPreview: res.functionCall.arguments?.slice(0, 60) }
          : undefined,
        toolCallId: res.toolCallId,
      });
      expect(res).toBeDefined();
      expect(typeof res.text).toBe('string');
      if (res.functionCall) {
        expect(res.functionCall.name).toBe('get_weather');
        expect(typeof res.functionCall.arguments).toBe('string');
        const args = JSON.parse(res.functionCall.arguments) as Record<string, unknown>;
        expect(args.city).toBeDefined();
        expect(res.toolCallId).toBeDefined();
        expect(typeof res.toolCallId).toBe('string');
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'generateWithTools full round-trip: tool call then executor result returned',
    async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Use get_weather for Beijing and tell me the result.' },
      ];
      const executedCalls: FunctionCall[] = [];
      logFlow(`[${providerName}] 4) Calling LLMService.generateWithTools (with toolExecutor)`, {
        messageCount: messages.length,
        toolNames: SAMPLE_TOOLS.map((t) => t.name),
      });
      const res = await llmService.generateWithTools(
        messages,
        SAMPLE_TOOLS,
        {
          maxToolRounds: 3,
          maxTokens: 1024,
          toolExecutor: async (call) => {
            logFlow(`[${providerName}] 4) toolExecutor invoked`, { name: call.name, args: call.arguments });
            executedCalls.push(call);
            return { temperature: 25, unit: 'celsius', condition: 'sunny' };
          },
        },
        providerName,
      );
      logFlow(`[${providerName}] 4) Response`, {
        stopReason: res.stopReason,
        toolCallsCount: res.toolCalls?.length ?? 0,
        executedCallsCount: executedCalls.length,
        textPreview: res.text?.slice(0, 100),
      });
      expect(res).toBeDefined();
      expect(res.stopReason).toBeDefined();
      expect(['end_turn', 'tool_use', 'max_rounds', undefined]).toContain(res.stopReason);
      expect(Array.isArray(res.toolCalls)).toBe(true);
      if (executedCalls.length > 0) {
        expect(executedCalls[0].name).toBe('get_weather');
        const toolCalls = res.toolCalls;
        expect(toolCalls).toBeDefined();
        expect(toolCalls && toolCalls.length >= 1).toBe(true);
        expect(toolCalls?.[0]?.tool).toBe('get_weather');
        expect(toolCalls?.[0]?.result).toEqual({ temperature: 25, unit: 'celsius', condition: 'sunny' });
      }
      if (res.stopReason === 'end_turn') {
        expect(typeof res.text).toBe('string');
        // When a tool was executed we expect a final summary; when none, model may return empty (e.g. provider-specific).
        if (executedCalls.length > 0) {
          expect(res.text.length).toBeGreaterThan(0);
        }
      }
    },
    INTEGRATION_TOOL_USE_TIMEOUT_MS,
  );
});

describe.skipIf(!getIntegrationProvider('deepseek'))('DeepSeek LLM integration (real API)', () => {
  const aiManager = createAIManagerWithProvider('deepseek');
  const llmService = new LLMService(aiManager);
  const providerName = 'deepseek';

  test(
    'generate returns text and optional usage',
    async () => {
      const prompt = 'Say "hello" in one short word.';
      logFlow(`[${providerName}] 1) Calling LLMService.generate`, { prompt });
      const res = await llmService.generate(prompt, undefined, providerName);
      logFlow(`[${providerName}] 1) Response`, {
        textPreview: res.text?.slice(0, 80),
        textLength: res.text?.length,
        usage: res.usage,
      });
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
      const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with only the number 42.' }];
      logFlow(`[${providerName}] 2) Calling LLMService.generateMessages`, { messageCount: messages.length });
      const res = await llmService.generateMessages(messages, {}, providerName);
      logFlow(`[${providerName}] 2) Response`, { textPreview: res.text?.slice(0, 80), textLength: res.text?.length });
      expect(res).toBeDefined();
      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'generate with tools: response has text or functionCall and parsed tool_call',
    async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'What is the weather in Beijing right now? Use the get_weather tool.' },
      ];
      logFlow(`[${providerName}] 3) Calling LLMService.generate with messages + tools`, {
        messageCount: messages.length,
        toolNames: SAMPLE_TOOLS.map((t) => t.name),
      });
      const res = await llmService.generate('', { messages, tools: SAMPLE_TOOLS, maxTokens: 1024 }, providerName);
      logFlow(`[${providerName}] 3) Response`, {
        textPreview: res.text?.slice(0, 80),
        functionCall: res.functionCall
          ? { name: res.functionCall.name, argsPreview: res.functionCall.arguments?.slice(0, 60) }
          : undefined,
        toolCallId: res.toolCallId,
      });
      expect(res).toBeDefined();
      expect(typeof res.text).toBe('string');
      if (res.functionCall) {
        expect(res.functionCall.name).toBe('get_weather');
        expect(typeof res.functionCall.arguments).toBe('string');
        const args = JSON.parse(res.functionCall.arguments) as Record<string, unknown>;
        expect(args.city).toBeDefined();
        expect(res.toolCallId).toBeDefined();
        expect(typeof res.toolCallId).toBe('string');
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    'generateWithTools full round-trip: tool call then executor result returned',
    async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Use get_weather for Beijing and tell me the result.' },
      ];
      const executedCalls: FunctionCall[] = [];
      logFlow(`[${providerName}] 4) Calling LLMService.generateWithTools (with toolExecutor)`, {
        messageCount: messages.length,
        toolNames: SAMPLE_TOOLS.map((t) => t.name),
      });
      const res = await llmService.generateWithTools(
        messages,
        SAMPLE_TOOLS,
        {
          maxToolRounds: 3,
          maxTokens: 1024,
          toolExecutor: async (call) => {
            logFlow(`[${providerName}] 4) toolExecutor invoked`, { name: call.name, args: call.arguments });
            executedCalls.push(call);
            return { temperature: 25, unit: 'celsius', condition: 'sunny' };
          },
        },
        providerName,
      );
      logFlow(`[${providerName}] 4) Response`, {
        stopReason: res.stopReason,
        toolCallsCount: res.toolCalls?.length ?? 0,
        executedCallsCount: executedCalls.length,
        textPreview: res.text?.slice(0, 100),
      });
      expect(res).toBeDefined();
      expect(res.stopReason).toBeDefined();
      expect(['end_turn', 'tool_use', 'max_rounds', undefined]).toContain(res.stopReason);
      expect(Array.isArray(res.toolCalls)).toBe(true);
      if (executedCalls.length > 0) {
        expect(executedCalls[0].name).toBe('get_weather');
        const toolCalls = res.toolCalls;
        expect(toolCalls).toBeDefined();
        expect(toolCalls && toolCalls.length >= 1).toBe(true);
        expect(toolCalls?.[0]?.tool).toBe('get_weather');
        expect(toolCalls?.[0]?.result).toEqual({ temperature: 25, unit: 'celsius', condition: 'sunny' });
      }
      if (res.stopReason === 'end_turn') {
        expect(typeof res.text).toBe('string');
        if (executedCalls.length > 0) {
          expect(res.text.length).toBeGreaterThan(0);
        }
      }
    },
    INTEGRATION_TOOL_USE_TIMEOUT_MS,
  );
});
