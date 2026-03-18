import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult, ToolSpec } from '@/tools/types';
import { buildToolUsageInstructions, executeToolCall, getReplyToolDefinitions } from '../replyTools';

/** Minimal stub that renders templates using their actual content for test assertions. */
const stubPromptManager = {
  render(templateName: string, vars?: Record<string, string>): string {
    if (templateName === 'llm.tool.no_tools.local') return '当前没有可用技能，请直接回答。';
    if (templateName === 'llm.tool.no_tools.native_search')
      return '当前没有本地可用技能；若需要查询公开互联网的最新信息，请直接使用 provider 内建搜索，再基于结果回答。';
    if (templateName === 'llm.tool.note.local') return '先调用技能，再回答。';
    if (templateName === 'llm.tool.note.native_search') return '优先使用 provider 内建搜索。';
    if (templateName === 'llm.tool.usage')
      return `${vars?.nativeSearchNote ?? ''}\n可用技能列表：\n${vars?.toolList ?? ''}`;
    return '';
  },
} as unknown as PromptManager;

const searchToolSpec: ToolSpec = {
  name: 'search',
  description: 'Search the web',
  executor: 'search',
  triggerKeywords: ['搜索', 'search'],
  parameters: {
    query: { type: 'string', required: true, description: 'Query' },
  },
};

const replyToolSpec: ToolSpec = {
  name: 'reply',
  description: 'Generate reply',
  executor: 'reply',
  visibility: ['internal'],
  parameters: {},
};

const getWeatherToolSpec: ToolSpec = {
  name: 'get_weather',
  description: 'Get the current weather for a given city.',
  executor: 'get_weather',
  parameters: {
    city: { type: 'string', required: true, description: 'City name' },
  },
  whenToUse: 'When user asks about weather.',
  examples: ['北京天气', '上海天气怎么样'],
};

/** Task type with no required params, used to test invalid JSON fallback (executor still runs with {}). */
const optionalOnlyToolSpec: ToolSpec = {
  name: 'optional_only',
  description: 'Optional params only.',
  executor: 'optional_only',
  parameters: {
    foo: { type: 'string', required: false, description: 'Optional' },
  },
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
    function makeToolManager(...specs: ToolSpec[]): ToolManager {
      const tm = new ToolManager();
      for (const spec of specs) {
        tm.registerTool(spec);
      }
      return tm;
    }

    it('returns tool definitions for all task types except reply (internal visibility)', () => {
      const toolManager = makeToolManager(searchToolSpec, replyToolSpec);

      const tools = getReplyToolDefinitions(toolManager);
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
      const toolManager = makeToolManager(searchToolSpec, getWeatherToolSpec);

      const tools = getReplyToolDefinitions(toolManager, { nativeWebSearchEnabled: true });
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('get_weather');
    });

    it('includes search when nativeWebSearchEnabled is false', () => {
      const toolManager = makeToolManager(searchToolSpec, getWeatherToolSpec);

      const tools = getReplyToolDefinitions(toolManager, { nativeWebSearchEnabled: false });
      expect(tools.map((t) => t.name).sort()).toEqual(['get_weather', 'search']);
    });

    it('converts parameters to JSON Schema shape', () => {
      const toolManager = makeToolManager(getWeatherToolSpec);

      const tools = getReplyToolDefinitions(toolManager);
      expect(tools[0].parameters.type).toBe('object');
      expect(tools[0].parameters.properties?.city).toEqual({
        type: 'string',
        description: 'City name',
      });
      expect(tools[0].parameters.required).toEqual(['city']);
    });
  });

  describe('ToolManager.toToolDefinitions', () => {
    it('converts tool specs to tool definitions', () => {
      const toolManager = new ToolManager();
      const tools = toolManager.toToolDefinitions([searchToolSpec, getWeatherToolSpec]);
      expect(tools.length).toBe(2);
      expect(tools.find((t) => t.name === 'search')).toBeDefined();
      expect(tools.find((t) => t.name === 'get_weather')).toBeDefined();
    });
  });

  describe('buildToolUsageInstructions', () => {
    it('returns fallback when tools is empty and nativeWebSearchEnabled is false', () => {
      const toolManager = new ToolManager();
      const text = buildToolUsageInstructions(toolManager, [], { nativeWebSearchEnabled: false }, stubPromptManager);
      expect(text).toContain('当前没有可用技能');
      expect(text).not.toContain('内建搜索');
    });

    it('returns fallback when tools is empty and nativeWebSearchEnabled is true', () => {
      const toolManager = new ToolManager();
      const text = buildToolUsageInstructions(toolManager, [], { nativeWebSearchEnabled: true }, stubPromptManager);
      expect(text).toContain('内建搜索');
    });

    it('returns full instructions with tool list when tools are provided', () => {
      const toolManager = new ToolManager();
      toolManager.registerTool(getWeatherToolSpec);
      const tools = getReplyToolDefinitions(toolManager);
      const text = buildToolUsageInstructions(toolManager, tools, { nativeWebSearchEnabled: false }, stubPromptManager);

      expect(text).toContain('get_weather');
      expect(text).toContain('Get the current weather');
      expect(text).toContain('适用时机');
      expect(text).toContain('When user asks about weather.');
      expect(text).toContain('示例');
      expect(text).toContain('北京天气');
      expect(text).toContain('可用技能列表');
    });
  });

  describe('executeToolCall', () => {
    it('resolves task type, builds task, and calls toolManager.execute', async () => {
      const executed: { call: ToolCall }[] = [];
      const toolManager = new ToolManager();
      toolManager.registerTool(getWeatherToolSpec);
      toolManager.registerExecutor({
        name: 'get_weather',
        execute: async (call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> => {
          executed.push({ call });
          return {
            success: true,
            reply: 'OK',
            data: { temperature: 22, city: call.parameters.city },
          };
        },
      });

      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('天气');

      const result = await executeToolCall(
        { name: 'get_weather', arguments: '{"city":"北京"}' },
        ctx,
        toolManager,
        hookManager,
      );

      expect(executed.length).toBe(1);
      expect(executed[0].call.type).toBe('get_weather');
      expect(executed[0].call.executor).toBe('get_weather');
      expect(executed[0].call.parameters).toEqual({ city: '北京' });
      expect(result).toEqual({ temperature: 22, city: '北京' });
    });

    it('returns result.reply when result.data is undefined', async () => {
      const toolManager = new ToolManager();
      toolManager.registerTool(searchToolSpec);
      toolManager.registerExecutor({
        name: 'search',
        execute: async (): Promise<ToolResult> => ({
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
        toolManager,
        hookManager,
      );

      expect(result).toBe('Search result text');
    });

    it('throws when task type not found', async () => {
      const toolManager = new ToolManager();
      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('');

      await expect(
        executeToolCall({ name: 'nonexistent', arguments: '{}' }, ctx, toolManager, hookManager),
      ).rejects.toThrow('Tool not found: nonexistent');
    });

    it('uses empty object for parameters when arguments JSON is invalid', async () => {
      const executed: { call: ToolCall }[] = [];
      const toolManager = new ToolManager();
      toolManager.registerTool(optionalOnlyToolSpec);
      toolManager.registerExecutor({
        name: 'optional_only',
        execute: async (call: ToolCall): Promise<ToolResult> => {
          executed.push({ call });
          return { success: true, reply: 'OK', data: {} };
        },
      });

      const hookManager = { execute: async () => true } as never;
      const ctx = makeHookContext('');

      await executeToolCall({ name: 'optional_only', arguments: 'not valid json' }, ctx, toolManager, hookManager);

      expect(executed.length).toBe(1);
      expect(executed[0].call.parameters).toEqual({});
    });
  });
});
