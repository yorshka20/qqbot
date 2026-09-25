// The prefix cache only pays off if every task of a run sends the same envelope, so these
// tests pin what BaseFanout guarantees: one tool list, system prompt and model for all
// tasks, per-task tool gating at execution time, and the first task warming the cache
// before the rest start.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, ToolDefinition, ToolUseGenerateOptions, ToolUseGenerateResponse } from '@/ai/types';
import type { Config } from '@/core/config';
import type { HookManager } from '@/hooks/HookManager';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import { BaseFanout, type FanoutContext } from '../BaseFanout';
import type { FanoutServices } from '../FanoutServices';
import type { FanoutTarget, FanoutTask, FanoutTaskOutput } from '../types';

interface Call {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: ToolUseGenerateOptions;
  provider?: string;
}

type Generate = (call: Call) => Promise<Partial<ToolUseGenerateResponse>>;

const TARGET: FanoutTarget = { chat: 'group', id: '10000001', name: '测试群', protocol: 'milky' };
const PREFIX = '## 共享前缀\n测试用户甲: 你好';

function makeServices(generate: Generate, executed: string[]): { services: FanoutServices; calls: Call[] } {
  const calls: Call[] = [];
  const specs = new Map<string, ToolSpec>(
    ['draw', 'lookup'].map((name) => [name, { name, description: name, executor: name } as ToolSpec]),
  );
  const llmService = {
    generateWithTools: async (
      messages: ChatMessage[],
      tools: ToolDefinition[],
      options: ToolUseGenerateOptions,
      provider?: string,
    ) => {
      const call = { messages, tools, options, provider };
      calls.push(call);
      return { text: '', ...(await generate(call)) };
    },
  } as unknown as LLMService;
  const toolManager = {
    getTool: (name: string) => specs.get(name) ?? null,
    getExecutor: (name: string) => (specs.has(name) ? {} : null),
    toToolDefinitions: (list: ToolSpec[]) => list.map((s) => ({ name: s.name, description: '', parameters: {} })),
    execute: async (toolCall: { type: string }) => {
      executed.push(toolCall.type);
      return { success: true, reply: 'done' };
    },
  } as unknown as ToolManager;
  const services: FanoutServices = {
    llmService,
    toolManager,
    hookManager: {} as HookManager,
    promptManager: { render: () => 'SYSTEM' } as unknown as PromptManager,
    config: {} as Config,
    botSelfId: '10000009',
  };
  return { services, calls };
}

class TestFanout extends BaseFanout<{ day: string }> {
  readonly name = 'test';
  protected readonly systemTemplate = 'test.system';
  constructor(
    services: FanoutServices,
    private readonly hasContext = true,
  ) {
    super(services);
  }
  protected resolveModel() {
    return { provider: 'p', model: 'm' };
  }
  protected async buildContext(): Promise<FanoutContext<{ day: string }> | null> {
    return this.hasContext ? { ctx: { day: 'd' }, prefix: PREFIX } : null;
  }
}

function task(
  name: string,
  tools: string[],
  overrides: Partial<FanoutTask<{ day: string }>> = {},
): FanoutTask<{ day: string }> & { outputs: FanoutTaskOutput[] } {
  const outputs: FanoutTaskOutput[] = [];
  return {
    name,
    tools,
    limits: { maxTokens: 100, timeout: 1000, maxToolRounds: 1 },
    parseParams: (raw: unknown) => raw,
    suffix: () => `## 任务 ${name}`,
    handle: async (output: FanoutTaskOutput) => {
      outputs.push(output);
    },
    outputs,
    ...overrides,
  };
}

const taskOf = (call: Call) => String(call.messages[1].content).split('## 任务 ')[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BaseFanout envelope', () => {
  it('sends one system prompt, model and tool union to every task, and only the suffix differs', async () => {
    const { services, calls } = makeServices(async () => ({}), []);
    const fanout = new TestFanout(services);
    fanout.registerTask(task('b', ['lookup']));
    fanout.registerTask(task('a', ['draw']));
    fanout.registerTask(task('c', []));

    const report = await fanout.run(TARGET, { a: {}, b: {}, c: {} });

    expect(report).toEqual({
      status: 'ran',
      tasks: ['a', 'b', 'c'].map((name) => ({ name, status: 'ok', rounds: 1, usage: undefined })),
    });
    expect(calls.map(taskOf)).toEqual(['a', 'b', 'c']);
    for (const call of calls) {
      expect(call.provider).toBe('p');
      expect(call.options.model).toBe('m');
      expect(call.tools.map((t) => t.name)).toEqual(['draw', 'lookup']);
      expect(call.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
      expect(String(call.messages[1].content).startsWith(`${PREFIX}\n\n`)).toBe(true);
    }
  });
});

describe('BaseFanout tool gating', () => {
  it('refuses a tool the task did not name, and runs the ones it did', async () => {
    const executed: string[] = [];
    const results: Record<string, unknown> = {};
    const { services } = makeServices(async (call) => {
      results[taskOf(call)] = await call.options.toolExecutor?.({ name: 'draw', arguments: '{}' });
      return {};
    }, executed);
    const fanout = new TestFanout(services);
    fanout.registerTask(task('artist', ['draw']));
    fanout.registerTask(task('memory', []));

    await fanout.run(TARGET, { artist: {}, memory: {} });

    expect(executed).toEqual(['draw']);
    expect(results.artist).toBe('done');
    expect(String(results.memory)).toContain('本任务不可调用 draw');
  });
});

describe('BaseFanout ordering', () => {
  it('starts the other tasks once the first task has its first round back, not when it finishes', async () => {
    const events: string[] = [];
    const { services } = makeServices(async (call) => {
      const name = taskOf(call);
      events.push(`${name}:start`);
      if (name === 'a') {
        await sleep(10);
        call.options.onProviderResolved?.({ providerName: 'p' });
        events.push('a:round1');
        await sleep(30);
      }
      events.push(`${name}:end`);
      return {};
    }, []);
    const fanout = new TestFanout(services);
    fanout.registerTask(task('a', ['draw']));
    fanout.registerTask(task('b', []));

    await fanout.run(TARGET, { a: {}, b: {} });

    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('a:round1'));
    expect(events.indexOf('b:start')).toBeLessThan(events.indexOf('a:end'));
  });

  it('still starts the rest when the first task fails before its first round', async () => {
    const { services, calls } = makeServices(async () => ({}), []);
    const fanout = new TestFanout(services);
    fanout.registerTask(
      task('a', [], {
        suffix: () => {
          throw new Error('broken suffix');
        },
      }),
    );
    const b = task('b', []);
    fanout.registerTask(b);

    const report = await fanout.run(TARGET, { a: {}, b: {} });

    expect(report.status === 'ran' && report.tasks.map((t) => t.status)).toEqual(['failed', 'ok']);
    expect(calls.map(taskOf)).toEqual(['b']);
    expect(b.outputs).toHaveLength(1);
  });
});

describe('BaseFanout run guards', () => {
  it('reports busy for a second run on the same target while the first is in progress', async () => {
    const { services } = makeServices(async () => {
      await sleep(20);
      return {};
    }, []);
    const fanout = new TestFanout(services);
    fanout.registerTask(task('a', []));

    const first = fanout.run(TARGET, { a: {} });
    const second = await fanout.run(TARGET, { a: {} });
    const otherTarget = await fanout.run({ ...TARGET, id: '10000002' }, { a: {} });

    expect(second).toEqual({ status: 'busy' });
    expect(otherTarget.status).toBe('ran');
    expect((await first).status).toBe('ran');
  });

  it('skips unregistered tasks and tasks whose params do not parse', async () => {
    const { services, calls } = makeServices(async () => ({}), []);
    const fanout = new TestFanout(services);
    fanout.registerTask(
      task('picky', [], {
        parseParams: () => {
          throw new Error('bad params');
        },
      }),
    );

    expect(await fanout.run(TARGET, { missing: {}, picky: {} })).toEqual({ status: 'no_tasks' });
    expect(calls).toHaveLength(0);
  });

  it('skips the run when there is no context to share', async () => {
    const { services, calls } = makeServices(async () => ({}), []);
    const fanout = new TestFanout(services, false);
    fanout.registerTask(task('a', []));

    expect(await fanout.run(TARGET, { a: {} })).toEqual({ status: 'no_context' });
    expect(calls).toHaveLength(0);
  });
});
