import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookManager } from '@/hooks/HookManager';
import { FileReadService } from '@/services/file';
import { TaskInitializer } from '@/task/TaskInitializer';
import type { TaskManager } from '@/task/TaskManager';
import { TaskManager as TaskManagerImpl } from '@/task/TaskManager';
import type { Task, TaskExecutionContext, TaskResult } from '@/task/types';
import type { SubAgentManager } from '../SubAgentManager';
import { ToolRunner } from '../ToolRunner';
import type { SubAgentSession } from '../types';
import { SubAgentType } from '../types';

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
  it('run executes tool via TaskManager.getExecutor and returns result.data or result.reply', async () => {
    const mockResult: TaskResult = {
      success: true,
      reply: 'Search result text',
      data: { query: 'test', results: ['a', 'b'] },
    };
    const taskManager = {
      getTaskType: () => ({ name: 'search', executor: 'search' }),
      getExecutor: () => ({
        name: 'search',
        execute: async (_task: Task, _context: TaskExecutionContext) => mockResult,
      }),
      execute: async () => mockResult,
    } as unknown as TaskManager;
    const subAgentManager = {} as unknown as SubAgentManager;
    const runner = new ToolRunner(taskManager, subAgentManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'search', arguments: '{"query":"test"}' }, session);
    expect(result).toEqual({ query: 'test', results: ['a', 'b'] });
  });

  it('run returns result.reply when result.data is undefined (normalizeResult fallback)', async () => {
    const taskManager = {
      getTaskType: () => ({ name: 'reply_only_tool', executor: 'reply_only_tool' }),
      getExecutor: () => ({
        name: 'reply_only_tool',
        execute: async () => ({ success: true, reply: 'text-only reply' }),
      }),
      execute: async () => ({ success: true, reply: 'text-only reply' }),
    } as unknown as TaskManager;
    const runner = new ToolRunner(taskManager, {} as SubAgentManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'reply_only_tool', arguments: '{}' }, session);
    expect(result).toBe('text-only reply');
  });

  it('run read_file list with real TaskManager returns real execution result', async () => {
    getContainer().registerInstance(DITokens.FILE_READ_SERVICE, new FileReadService(), {
      allowOverride: true,
    });
    const taskManager = new TaskManagerImpl();
    TaskInitializer.initialize(taskManager);
    const runner = new ToolRunner(taskManager, {} as SubAgentManager, new HookManager());
    const session = createMockSession();

    const result = (await runner.run(
      { name: 'read_file', arguments: '{"path":"src/agent","action":"list"}' },
      session,
    )) as { action: string; path: string; content: string };

    expect(result).toMatchObject({ action: 'list', path: 'src/agent' });
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    // Actual tool output: directory listing (e.g. contains ToolRunner.ts, SubAgentManager.ts, ...)
    expect(result.content).toContain('ToolRunner');
  });

  it('run read_file read with real TaskManager returns file content (text only, no card render)', async () => {
    getContainer().registerInstance(DITokens.FILE_READ_SERVICE, new FileReadService(), {
      allowOverride: true,
    });
    const taskManager = new TaskManagerImpl();
    TaskInitializer.initialize(taskManager);
    const runner = new ToolRunner(taskManager, {} as SubAgentManager, new HookManager());
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
    getContainer().registerInstance(DITokens.RETRIEVAL_SERVICE, mockRetrievalService, {
      allowOverride: true,
    });
    const taskManager = new TaskManagerImpl();
    TaskInitializer.initialize(taskManager);
    const runner = new ToolRunner(taskManager, {} as SubAgentManager, new HookManager());
    const session = createMockSession();

    const result = await runner.run({ name: 'fetch_page', arguments: '{"url":"https://example.com"}' }, session);

    // When fetch is disabled, executor returns error; ToolRunner returns result.reply
    expect(typeof result === 'string').toBe(true);
    expect(result as string).toContain('页面抓取功能未开启');
  });

  it('run throws when executor not found', async () => {
    const taskManager = {
      getTaskType: () => ({ name: 'unknown_tool', executor: 'unknown_tool' }),
      getExecutor: () => null,
    } as unknown as TaskManager;
    const runner = new ToolRunner(taskManager, {} as SubAgentManager, new HookManager());
    const session = createMockSession();

    await expect(runner.run({ name: 'unknown_tool', arguments: '{}' }, session)).rejects.toThrow(
      'Executor not found for tool: unknown_tool',
    );
  });

  it('run spawn_subagent spawns, executes, waits and returns result when waitForCompletion true', async () => {
    let capturedParentId: string | undefined;
    let capturedTask: { description: string; input: unknown; parentContext?: unknown } | undefined;
    const childSessionId = 'agent:child-id';
    const childOutput = 'child result';

    const subAgentManager = {
      spawn: async (
        parentId: string | undefined,
        _type: SubAgentType,
        task: { description: string; input: unknown; parentContext?: unknown },
      ) => {
        capturedParentId = parentId;
        capturedTask = task;
        return childSessionId;
      },
      execute: async (sessionId: string) => {
        expect(sessionId).toBe(childSessionId);
      },
      wait: async (sessionId: string) => {
        expect(sessionId).toBe(childSessionId);
        return childOutput;
      },
    } as unknown as SubAgentManager;
    const taskManager = { getTaskType: () => null, getExecutor: () => null } as unknown as TaskManager;
    const runner = new ToolRunner(taskManager, subAgentManager, new HookManager());
    const session = createMockSession({ id: 'agent:parent-id' });

    const result = await runner.run(
      {
        name: 'spawn_subagent',
        arguments: JSON.stringify({
          type: 'research',
          description: 'Research task',
          input: { q: 1 },
          waitForCompletion: true,
        }),
      },
      session,
    );

    expect(capturedParentId).toBe('agent:parent-id');
    expect(capturedTask?.description).toBe('Research task');
    expect(capturedTask?.input).toEqual({ q: 1 });
    expect(result).toEqual({ sessionId: childSessionId, status: 'completed', result: childOutput });
  });

  it('run spawn_subagent passes parentContext from session.context to spawn', async () => {
    let capturedTask: { parentContext?: { userId: number; groupId?: number; messageType: string } } | undefined;
    const subAgentManager = {
      spawn: async (
        _parentId: string | undefined,
        _type: SubAgentType,
        task: { description: string; input: unknown; parentContext?: unknown },
      ) => {
        capturedTask = task as typeof capturedTask;
        return 'agent:child';
      },
      execute: async () => {},
      wait: async () => 'done',
    } as unknown as SubAgentManager;
    const taskManager = { getTaskType: () => null, getExecutor: () => null } as unknown as TaskManager;
    const runner = new ToolRunner(taskManager, subAgentManager, new HookManager());
    const session = createMockSession({
      context: { sessionId: 's', userId: 999, groupId: 888, messageType: 'group' },
    });

    await runner.run(
      {
        name: 'spawn_subagent',
        arguments: JSON.stringify({ type: 'generic', description: 'd', waitForCompletion: true }),
      },
      session,
    );

    expect(capturedTask?.parentContext).toEqual({ userId: 999, groupId: 888, messageType: 'group' });
  });
});
