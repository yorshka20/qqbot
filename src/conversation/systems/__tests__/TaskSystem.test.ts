import { describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai/AIService';
import { TaskSystem } from '@/conversation/systems/TaskSystem';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskResult, TaskType } from '@/task/types';

function makeContext(opts: { message: string; hasReply?: boolean; hasCommand?: boolean }): HookContext {
  const metadata = new HookMetadataMap();
  return {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 1,
      groupId: 2,
      messageType: 'group',
      message: opts.message,
      segments: [],
    },
    context: {
      userMessage: opts.message,
      history: [],
      userId: 1,
      groupId: 2,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
    ...(opts.hasReply ? { reply: { source: 'ai', segments: [{ type: 'text', data: { text: 'r' } }] } } : {}),
    ...(opts.hasCommand ? { command: { name: 'help', args: [] } } : {}),
  } as HookContext;
}

describe('TaskSystem', () => {
  it('when useToolUse is true, calls only generateReplyWithToolUse', async () => {
    const generateReplyWithToolUseCalls: HookContext[] = [];
    const generateReplyFromTaskResultsCalls: Array<{ context: HookContext; results: unknown }> = [];
    const analyzeTaskCalls: HookContext[] = [];

    const aiService = {
      generateReplyWithToolUse: async (ctx: HookContext) => {
        generateReplyWithToolUseCalls.push(ctx);
      },
      generateReplyFromTaskResults: async (ctx: HookContext, results: unknown) => {
        generateReplyFromTaskResultsCalls.push({ context: ctx, results });
      },
      analyzeTask: async (ctx: HookContext) => {
        analyzeTaskCalls.push(ctx);
        return { tasks: [], suggestedProvider: undefined };
      },
    } as unknown as AIService;

    const taskManager = {
      getAllTaskTypes: (): TaskType[] => [],
      getExecutor: () => () => ({}),
      execute: async (
        _task: Task,
        _ctx: unknown,
        _hookManager: unknown,
        _context: HookContext,
      ): Promise<TaskResult> => ({
        success: true,
        reply: '',
        data: undefined,
      }),
    } as unknown as TaskManager;

    const hookManager = {} as never;

    const system = new TaskSystem(taskManager, hookManager, aiService, true);
    const context = makeContext({ message: 'hello' });

    await system.execute(context);

    expect(generateReplyWithToolUseCalls.length).toBe(1);
    expect(generateReplyWithToolUseCalls[0].message.message).toBe('hello');
    expect(analyzeTaskCalls.length).toBe(0);
    expect(generateReplyFromTaskResultsCalls.length).toBe(0);
  });

  it('when useToolUse is false, uses legacy path and calls generateReplyFromTaskResults', async () => {
    const generateReplyWithToolUseCalls: HookContext[] = [];
    const generateReplyFromTaskResultsCalls: Array<{ context: HookContext; results: unknown }> = [];
    const analyzeTaskCalls: HookContext[] = [];

    const aiService = {
      generateReplyWithToolUse: async (ctx: HookContext) => {
        generateReplyWithToolUseCalls.push(ctx);
      },
      generateReplyFromTaskResults: async (ctx: HookContext, results: unknown) => {
        generateReplyFromTaskResultsCalls.push({ context: ctx, results });
      },
      analyzeTask: async (ctx: HookContext) => {
        analyzeTaskCalls.push(ctx);
        return {
          tasks: [{ type: 'read_file', parameters: { path: 'README.md', action: 'read' }, executor: 'read_file' }],
          suggestedProvider: undefined,
        };
      },
    } as unknown as AIService;

    const executeCalls: Task[] = [];
    const taskManager = {
      getAllTaskTypes: (): TaskType[] => [
        {
          name: 'read_file',
          description: 'Read file',
          executor: 'read_file',
          triggerKeywords: ['读取'],
          parameters: {},
        },
      ],
      getExecutor: () => () => ({}),
      execute: async (task: Task, _ctx: unknown, _hookManager: unknown, _context: HookContext): Promise<TaskResult> => {
        executeCalls.push(task);
        return { success: true, reply: '', data: undefined };
      },
    } as unknown as TaskManager;

    const hookManager = {
      execute: async () => true,
    } as never;

    const system = new TaskSystem(taskManager, hookManager, aiService, false);
    const context = makeContext({ message: '读取一下文件' });

    await system.execute(context);

    expect(generateReplyWithToolUseCalls.length).toBe(0);
    expect(analyzeTaskCalls.length).toBe(1);
    expect(executeCalls.length).toBe(1);
    expect(generateReplyFromTaskResultsCalls.length).toBe(1);
  });

  it('skips execution when context has reply', async () => {
    const generateReplyWithToolUseCalls: HookContext[] = [];
    const aiService = {
      generateReplyWithToolUse: async (ctx: HookContext) => {
        generateReplyWithToolUseCalls.push(ctx);
      },
    } as unknown as AIService;

    const taskManager = {} as unknown as TaskManager;
    const hookManager = {} as never;

    const system = new TaskSystem(taskManager, hookManager, aiService, true);
    const context = makeContext({ message: 'hi', hasReply: true });

    await system.execute(context);

    expect(generateReplyWithToolUseCalls.length).toBe(0);
  });

  it('skips execution when context has command', async () => {
    const generateReplyWithToolUseCalls: HookContext[] = [];
    const aiService = {
      generateReplyWithToolUse: async (ctx: HookContext) => {
        generateReplyWithToolUseCalls.push(ctx);
      },
    } as unknown as AIService;

    const taskManager = {} as unknown as TaskManager;
    const hookManager = {} as never;

    const system = new TaskSystem(taskManager, hookManager, aiService, true);
    const context = makeContext({ message: '/help', hasCommand: true });

    await system.execute(context);

    expect(generateReplyWithToolUseCalls.length).toBe(0);
  });
});
