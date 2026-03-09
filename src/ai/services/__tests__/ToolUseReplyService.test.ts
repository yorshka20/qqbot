import 'reflect-metadata';
import { describe, expect, it, test } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { HookManager } from '@/hooks/HookManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { TaskManager } from '@/task/TaskManager';
import type { Task, TaskExecutionContext, TaskResult, TaskType } from '@/task/types';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TOOL_USE_TIMEOUT_MS,
} from '../integrationTestHelpers';
import { LLMService } from '../LLMService';
import { ToolUseReplyService } from '../ToolUseReplyService';

function makeHookContext(messageText: string): HookContext {
  const metadata = new HookMetadataMap();
  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      message: messageText,
      segments: [],
    },
    context: {
      userMessage: messageText,
      history: [],
      userId: 456,
      groupId: 1,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
  };
}

const searchTaskType: TaskType = {
  name: 'search',
  description: 'Search the web',
  executor: 'search',
  triggerKeywords: ['搜索', 'search'],
  parameters: {
    query: { type: 'string', required: true, description: 'Query' },
  },
};

describe('ToolUseReplyService', () => {
  describe('tool exposure and prompting', () => {
    it('includes task tools in the exposed tool list', async () => {
      const capturedTools: { name: string }[] = [];
      const llmService = {
        generateWithTools: async (_messages: unknown[], tools: { name: string }[], _options?: unknown) => {
          capturedTools.push(...tools);
          return { text: 'ok' };
        },
        generateMessages: async () => ({ text: 'plain' }),
      } as never;

      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType],
        getExecutor: () => null,
        execute: async () => ({ success: true, reply: '', data: null }),
      } as unknown as TaskManager;

      const promptManager = {
        renderBasePrompt: () => '',
        render: (_name: string, vars?: Record<string, string>) => vars?.toolUsageInstructions ?? '',
      } as never;

      const service = new ToolUseReplyService(llmService, taskManager, promptManager);

      await service.generateReply(makeHookContext('搜索一下 React'));

      expect(capturedTools.some((t) => t.name === 'search')).toBe(true);
    });

    it('does not expose spawn_subagent as an LLM tool', async () => {
      const capturedTools: { name: string }[] = [];
      const llmService = {
        generateWithTools: async (_messages: unknown[], tools: { name: string }[], _options?: unknown) => {
          capturedTools.push(...tools);
          return { text: 'ok' };
        },
        generateMessages: async () => ({ text: 'plain' }),
      } as never;

      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType],
        getExecutor: () => null,
        execute: async () => ({ success: true, reply: '', data: null }),
      } as unknown as TaskManager;

      const promptManager = {
        renderBasePrompt: () => '',
        render: (_name: string, vars?: Record<string, string>) => vars?.toolUsageInstructions ?? '',
      } as never;

      const service = new ToolUseReplyService(llmService, taskManager, promptManager);

      await service.generateReply(makeHookContext('搜索一下'));

      expect(capturedTools.some((t) => t.name === 'search')).toBe(true);
      expect(capturedTools.some((t) => t.name === 'spawn_subagent')).toBe(false);
    });

    it('uses tool-use path even when the message has no trigger keywords', async () => {
      let generateWithToolsCalled = false;
      let generateMessagesCalled = false;
      const llmService = {
        generateWithTools: async () => {
          generateWithToolsCalled = true;
          return { text: 'ok' };
        },
        generateMessages: async () => {
          generateMessagesCalled = true;
          return { text: 'plain reply' };
        },
      } as never;

      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType],
        getExecutor: () => null,
        execute: async () => ({ success: true, reply: '', data: null }),
      } as unknown as TaskManager;

      const promptManager = {
        renderBasePrompt: () => '',
        render: (_name: string, vars?: Record<string, string>) => vars?.toolUsageInstructions ?? '',
      } as never;

      const service = new ToolUseReplyService(llmService, taskManager, promptManager);

      const reply = await service.generateReply(makeHookContext('今天天气怎么样'));

      expect(generateWithToolsCalled).toBe(true);
      expect(generateMessagesCalled).toBe(false);
      expect(reply).toBe('ok');
    });

    it('hides local search tool when provider native search is enabled', async () => {
      let generateWithToolsCalled = false;
      let generateMessagesCalled = false;
      const llmService = {
        supportsNativeWebSearch: async () => true,
        generateWithTools: async () => {
          generateWithToolsCalled = true;
          return { text: 'tool reply' };
        },
        generateMessages: async () => {
          generateMessagesCalled = true;
          return { text: 'native search reply' };
        },
      } as never;

      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType],
        getExecutor: () => null,
        execute: async () => ({ success: true, reply: '', data: null }),
      } as unknown as TaskManager;

      const promptManager = {
        renderBasePrompt: () => '',
        render: (_name: string, vars?: Record<string, string>) => vars?.toolUsageInstructions ?? '',
      } as never;

      const service = new ToolUseReplyService(llmService, taskManager, promptManager);

      const reply = await service.generateReply(makeHookContext('搜索一下 React'));

      expect(generateWithToolsCalled).toBe(false);
      expect(generateMessagesCalled).toBe(true);
      expect(reply).toBe('native search reply');
      expect(service.getAvailableToolDefinitions({ nativeWebSearchEnabled: true })).toEqual([]);
    });
  });

  /**
   * Integration: real LLM API + real tool execution.
   * Requires config.jsonc (or CONFIG_PATH) with doubao or deepseek configured.
   * Flow: user message triggers tool (get_weather) -> LLMService.generateWithTools (real API)
   * -> model may call get_weather -> toolExecutor runs real TaskManager.execute -> executor returns result
   * -> LLM generates final reply.
   */
  describe.skipIf(!getIntegrationProvider('doubao'))('integration (real LLM and real tool execution)', () => {
    const providerName = 'doubao';
    const aiManager = createAIManagerWithProvider(providerName);
    const llmService = new LLMService(aiManager);

    // Task type that matches SAMPLE_TOOLS-style get_weather so the model is likely to call it
    const getWeatherTaskType: TaskType = {
      name: 'get_weather',
      description: 'Get the current weather for a given city.',
      executor: 'get_weather',
      triggerKeywords: ['天气', 'weather', '北京', '上海'],
      parameters: {
        city: { type: 'string', required: true, description: 'City name' },
      },
    };

    const executedCalls: { name: string; args: string }[] = [];
    const taskManager = new TaskManager();
    taskManager.registerTaskType(getWeatherTaskType);
    taskManager.registerExecutor({
      name: 'get_weather',
      execute: async (task: Task, _context: TaskExecutionContext): Promise<TaskResult> => {
        executedCalls.push({ name: task.type, args: JSON.stringify(task.parameters) });
        return {
          success: true,
          reply: 'OK',
          data: { temperature: 22, unit: 'celsius', condition: 'sunny' },
        };
      },
    });

    const hookManager = new HookManager();
    const promptManager = new PromptManager('/nonexistent');
    const service = new ToolUseReplyService(llmService, taskManager, promptManager, hookManager);

    test(
      'generateReply with tool-triggering message returns reply and executes tool when model calls it',
      async () => {
        executedCalls.length = 0;
        const ctx = makeHookContext('北京天气怎么样');
        const reply = await service.generateReply(ctx);
        expect(typeof reply).toBe('string');
        expect(reply.length).toBeGreaterThan(0);
        if (executedCalls.length > 0) {
          expect(executedCalls.some((c) => c.name === 'get_weather')).toBe(true);
        }
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS,
    );

    test(
      'generateReply with non-triggering message uses plain reply path',
      async () => {
        const ctx = makeHookContext('你好，随便聊几句');
        const reply = await service.generateReply(ctx);
        expect(typeof reply).toBe('string');
        expect(reply.length).toBeGreaterThan(0);
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS,
    );
  });
});
