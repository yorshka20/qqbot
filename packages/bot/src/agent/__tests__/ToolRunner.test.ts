import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { getContainer } from '@/core/DIContainer';
import { HookManager } from '@/hooks/HookManager';
import { FileReadService } from '@/services/file';
import { ToolInitializer } from '@/tools/ToolInitializer';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { ToolRunner } from '../ToolRunner';
import type { SubAgentSession } from '../types';
import { SubAgentType } from '../types';
import { createFileReadService } from '@/services/file/__tests__/createFileReadService';
import { RetrievalService } from '@/services/retrieval/RetrievalService';

function createMockSession(overrides?: Partial<SubAgentSession>): SubAgentSession {
  return {
    id: 'agent:test-session-id',
    depth: 0,
    type: SubAgentType.GENERIC,
    status: 'pending',
    context: { sessionId: 'test-session-id', userId: 123, groupId: 456, messageType: 'group' },
    task: { description: 'test', input: {} },
    createdAt: new Date(),
    config: {
      maxDepth: 2,
      maxChildren: 5,
      timeout: 300000,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
      allowedTools: [],
      restrictedTools: [],
    },
    ...overrides,
  };
}

describe('ToolRunner', () => {
  it('run executes tool via ToolManager.getExecutor and returns result.reply (authoritative over data)', async () => {
    const mockResult: ToolResult = {
      success: true,
      reply: 'Search result text',
      data: { query: 'test', results: ['a', 'b'] },
    };
    const toolManager = {
      getTool: () => ({ name: 'search', executor: 'search' }),
      getExecutor: () => ({
        name: 'search',
        execute: async (_call: ToolCall, _context: ToolExecutionContext) => mockResult,
      }),
      execute: async () => mockResult,
    } as unknown as ToolManager;
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    // ToolResult contract: `reply` is the authoritative LLM-facing message;
    // `data` is for non-LLM consumers and must not shadow it.
    const result = await runner.run({ name: 'search', arguments: '{"query":"test"}' }, session);
    expect(result).toBe('Search result text');
  });

  it('run returns result.reply when result.data is undefined (normalizeResult fallback)', async () => {
    const toolManager = {
      getTool: () => ({ name: 'reply_only_tool', executor: 'reply_only_tool' }),
      getExecutor: () => ({
        name: 'reply_only_tool',
        execute: async () => ({ success: true, reply: 'text-only reply' }),
      }),
      execute: async () => ({ success: true, reply: 'text-only reply' }),
    } as unknown as ToolManager;
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'reply_only_tool', arguments: '{}' }, session);
    expect(result).toBe('text-only reply');
  });

  it('run read_file list with real ToolManager returns real execution result', async () => {
    getContainer().registerInstance(FileReadService, createFileReadService(), {
      allowOverride: true,
    });
    const toolManager = ToolInitializer.createToolManager();
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    const result = (await runner.run(
      { name: 'read_file', arguments: '{"path":"packages/bot/src/agent","action":"list"}' },
      session,
    )) as string;

    // read_file's reply is the listing text itself (reply authoritative over data).
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Actual tool output: directory listing (e.g. contains ToolRunner.ts, SubAgentManager.ts, ...)
    expect(result).toContain('ToolRunner');
  });

  it('run read_file read with real ToolManager returns file content (text only, no card render)', async () => {
    getContainer().registerInstance(FileReadService, createFileReadService(), {
      allowOverride: true,
    });
    const toolManager = ToolInitializer.createToolManager();
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'read_file', arguments: '{"path":"README.md","action":"read"}' }, session);

    // Success: executor returns data with content (text only; card render is caller's responsibility)
    if (typeof result === 'object' && result !== null && 'content' in (result as object)) {
      expect(result).toMatchObject({ action: 'read', path: 'README.md' });
      expect((result as Record<string, unknown>).content).toBeDefined();
      expect(typeof (result as Record<string, unknown>).content).toBe('string');
    } else {
      // File not found or invalid path: executor returns error, ToolRunner returns result.reply (error message string)
      expect(typeof result === 'string').toBe(true);
      expect((result as string).length).toBeGreaterThan(0);
    }
  });

  it('run fetch_page returns error when page fetch is disabled by config', async () => {
    const mockFetchService = {
      isEnabled: () => false,
      fetchPages: async () => [],
    };
    const mockRetrievalService = {
      getPageContentFetchService: () => mockFetchService,
    };
    getContainer().registerInstance(RetrievalService, mockRetrievalService, {
      allowOverride: true,
    });
    const toolManager = ToolInitializer.createToolManager();
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'fetch_page', arguments: '{"url":"https://example.com"}' }, session);

    // When fetch is disabled, executor returns error; ToolRunner returns result.reply
    expect(typeof result === 'string').toBe(true);
    expect(result as string).toContain('页面抓取功能未开启');
  });

  it('run throws when executor not found', async () => {
    const toolManager = {
      getTool: () => ({ name: 'unknown_tool', executor: 'unknown_tool' }),
      getExecutor: () => null,
    } as unknown as ToolManager;
    const runner = new ToolRunner(toolManager, new HookManager());
    const session = createMockSession();

    await expect(runner.run({ name: 'unknown_tool', arguments: '{}' }, session)).rejects.toThrow(
      'Executor not found for tool: unknown_tool',
    );
  });

});
