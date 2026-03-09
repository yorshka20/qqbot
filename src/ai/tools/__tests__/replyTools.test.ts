import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { TaskManager } from '@/task/TaskManager';
import type { Task, TaskExecutionContext, TaskResult, TaskType } from '@/task/types';
import {
  buildToolUsageInstructions,
  executeToolCall,
  getReplyToolDefinitions,
  taskTypesToToolDefinitions,
} from '../replyTools';

const searchTaskType: TaskType = {
  name: 'search',
  description: 'Search the web',
  executor: 'search',
  triggerKeywords: ['搜索', 'search'],
  parameters: {
    query: { type: 'string', required: true, description: 'Query' },
  },
};

const replyTaskType: TaskType = {
  name: 'reply',
  description: 'Generate reply',
  executor: 'reply',
  parameters: {},
};

const getWeatherTaskType: TaskType = {
  name: 'get_weather',
  description: 'Get the current weather for a given city.',
  executor: 'get_weather',
  parameters: {
    city: { type: 'string', required: true, description: 'City name' },
  },
  whenToUse: 'When user asks about weather.',
  examples: ['北京天气', '上海天气怎么样'],
};

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

describe('replyTools', () => {
  describe('getReplyToolDefinitions', () => {
    it('returns tool definitions for all task types except reply', () => {
      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType, replyTaskType],
      } as unknown as TaskManager;

      const tools = getReplyToolDefinitions(taskManager);
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('search');
      expect(tools[0].description).toBe('Search the web');
      expect(tools[0].parameters.properties?.query).toEqual({
        type: 'string',
        description: 'Query',
      });
      expect(tools[0].parameters.required).toContain('query');
    });

    it('excludes search when nativeWebSearchEnabled is true', () => {
      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType, getWeatherTaskType],
      } as unknown as TaskManager;

      const tools = getReplyToolDefinitions(taskManager, { nativeWebSearchEnabled: true });
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('get_weather');
    });

    it('includes search when nativeWebSearchEnabled is false', () => {
      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [searchTaskType, getWeatherTaskType],
      } as unknown as TaskManager;

      const tools = getReplyToolDefinitions(taskManager, { nativeWebSearchEnabled: false });
      expect(tools.map((t) => t.name).sort()).toEqual(['get_weather', 'search']);
    });

    it('converts parameters to JSON Schema shape', () => {
      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [getWeatherTaskType],
      } as unknown as TaskManager;

      const tools = getReplyToolDefinitions(taskManager);
      expect(tools[0].parameters.type).toBe('object');
      expect(tools[0].parameters.properties?.city).toEqual({
        type: 'string',
        description: 'City name',
      });
      expect(tools[0].parameters.required).toEqual(['city']);
    });
  });

  describe('taskTypesToToolDefinitions', () => {
    it('converts task types to tool definitions', () => {
      const tools = taskTypesToToolDefinitions([searchTaskType, getWeatherTaskType]);
      expect(tools.length).toBe(2);
      expect(tools.find((t) => t.name === 'search')).toBeDefined();
      expect(tools.find((t) => t.name === 'get_weather')).toBeDefined();
    });
  });

  describe('buildToolUsageInstructions', () => {
    it('returns fallback when tools is empty and nativeWebSearchEnabled is false', () => {
      const taskManager = { getAllTaskTypes: (): TaskType[] => [] } as unknown as TaskManager;
      const text = buildToolUsageInstructions(taskManager, [], { nativeWebSearchEnabled: false });
      expect(text).toContain('当前没有可用工具');
      expect(text).not.toContain('内建搜索');
    });

    it('returns fallback when tools is empty and nativeWebSearchEnabled is true', () => {
      const taskManager = { getAllTaskTypes: (): TaskType[] => [] } as unknown as TaskManager;
      const text = buildToolUsageInstructions(taskManager, [], { nativeWebSearchEnabled: true });
      expect(text).toContain('内建搜索');
    });

    it('returns full instructions with tool list when tools are provided', () => {
      const taskManager = {
        getAllTaskTypes: (): TaskType[] => [getWeatherTaskType],
      } as unknown as TaskManager;
      const tools = getReplyToolDefinitions(taskManager);
      const text = buildToolUsageInstructions(taskManager, tools, { nativeWebSearchEnabled: false });

      expect(text).toContain('get_weather');
      expect(text).toContain('Get the current weather');
      expect(text).toContain('适用时机');
      expect(text).toContain('When user asks about weather.');
      expect(text).toContain('示例');
      expect(text).toContain('北京天气');
      expect(text).toContain('可用工具列表');
    });
  });

  describe('executeToolCall', () => {
    it('resolves task type, builds task, and calls taskManager.execute', async () => {
      const executed: { task: Task }[] = [];
      const taskManager = new TaskManager();
      taskManager.registerTaskType(getWeatherTaskType);
      taskManager.registerExecutor({
        name: 'get_weather',
        execute: async (task: Task, _context: TaskExecutionContext): Promise<TaskResult> => {
          executed.push({ task });
          return {
            success: true,
            reply: 'OK',
            data: { temperature: 22, city: task.parameters.city },
          };
        },
      });

      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('天气');

      const result = await executeToolCall(
        { name: 'get_weather', arguments: '{"city":"北京"}' },
        ctx,
        taskManager,
        hookManager,
      );

      expect(executed.length).toBe(1);
      expect(executed[0].task.type).toBe('get_weather');
      expect(executed[0].task.parameters).toEqual({ city: '北京' });
      expect(result).toEqual({ temperature: 22, city: '北京' });
    });

    it('returns result.reply when result.data is undefined', async () => {
      const taskManager = new TaskManager();
      taskManager.registerTaskType(searchTaskType);
      taskManager.registerExecutor({
        name: 'search',
        execute: async (): Promise<TaskResult> => ({
          success: true,
          reply: 'Search result text',
          data: undefined,
        }),
      });

      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('search');

      const result = await executeToolCall(
        { name: 'search', arguments: '{"query":"test"}' },
        ctx,
        taskManager,
        hookManager,
      );

      expect(result).toBe('Search result text');
    });

    it('throws when task type not found', async () => {
      const taskManager = new TaskManager();
      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('');

      await expect(
        executeToolCall({ name: 'nonexistent', arguments: '{}' }, ctx, taskManager, hookManager),
      ).rejects.toThrow('Task type not found for tool: nonexistent');
    });
  });
});
