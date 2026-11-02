import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DshExecutor } from '../executors/DshExecutor';
import type { AgentTask } from '../types';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    executor: 'dsh',
    model: 'deepseek-flash',
    prompt: 'do the thing',
    createdAt: new Date(),
    status: 'pending',
    requestedBy: { type: 'user', id: '10000001' },
    ...overrides,
  };
}

const MCP_URL = 'http://127.0.0.1:9876/mcp';

/** The overlay is a `dsh --patch` list; index 0 patches the model, index 1 inserts the MCP server. */
async function readOverlay(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, any>>;
}

describe('DshExecutor invocation', () => {
  test('runs one headless task in JSON mode with the prompt on stdin', async () => {
    const executor = new DshExecutor({});
    const invocation = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'rendered prompt',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    expect(invocation.cmd.slice(0, 2)).toEqual(['dsh', 'headless']);
    expect(invocation.cmd.at(-2)).toBe('--json');
    expect(invocation.cmd.at(-1)).toBe('-');
    expect(invocation.cmd).toContain('--patch');
    expect(invocation.stdin).toBe('rendered prompt');
    await invocation.cleanup();
  });

  test('cliPath overrides the binary', async () => {
    const executor = new DshExecutor({ cliPath: '/opt/dsh' });
    const invocation = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    expect(invocation.cmd[0]).toBe('/opt/dsh');
    await invocation.cleanup();
  });

  test('skips the approval prompt, which no one is present to answer', async () => {
    const executor = new DshExecutor({});
    const invocation = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    expect(invocation.env.DSH_PERMISSION_MODE).toBe('danger-full-access');
    await invocation.cleanup();
  });

  test('pins the provider and model rather than following the CLI default', async () => {
    const executor = new DshExecutor({ provider: 'deepseek-official' });
    const invocation = await executor.buildInvocation({
      task: makeTask({ model: 'deepseek-v4-pro' }),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    const overlay = await readOverlay(invocation.cmd[3]);
    expect(overlay[0]).toEqual({
      id: 'agent-default-model',
      config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    });
    await invocation.cleanup();
  });

  test('defaults to the DeepSeek account route, which needs no API key in the environment', async () => {
    const executor = new DshExecutor({});
    const invocation = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    const overlay = await readOverlay(invocation.cmd[3]);
    expect(overlay[0].config.provider).toBe('deepseek-account');
    await invocation.cleanup();
  });

  test('passes the task effort through and omits it when unset', async () => {
    const executor = new DshExecutor({});
    const withEffort = await executor.buildInvocation({
      task: makeTask({ effort: 'high' }),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });
    expect((await readOverlay(withEffort.cmd[3]))[0].config.reasoningEffort).toBe('high');
    await withEffort.cleanup();

    const withoutEffort = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });
    expect('reasoningEffort' in (await readOverlay(withoutEffort.cmd[3]))[0].config).toBe(false);
    await withoutEffort.cleanup();
  });

  test('registers the bot MCP endpoint with the task id header the server identifies callers by', async () => {
    const executor = new DshExecutor({});
    const task = makeTask();
    const invocation = await executor.buildInvocation({
      task,
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    const inserted = (await readOverlay(invocation.cmd[3]))[1].insert;
    expect(inserted).toHaveLength(1);
    expect(inserted[0].name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(inserted[0].config).toEqual({
      serverName: 'qqbot',
      transport: 'streamable-http',
      url: MCP_URL,
      headers: { 'X-Task-Id': task.id },
    });
    await invocation.cleanup();
  });

  test('cleanup removes the overlay', async () => {
    const executor = new DshExecutor({});
    const invocation = await executor.buildInvocation({
      task: makeTask(),
      prompt: 'p',
      workingDirectory: '/tmp/ws',
      mcpUrl: MCP_URL,
    });

    const overlayPath = invocation.cmd[3];
    expect(existsSync(overlayPath)).toBe(true);
    await invocation.cleanup();
    expect(existsSync(overlayPath)).toBe(false);
  });
});

describe('DshExecutor catalog', () => {
  test('offers the route catalog, the configured model and any extras', async () => {
    const executor = new DshExecutor({ model: 'deepseek-v4-pro', models: ['deepseek-experimental'] });
    const ids = (await executor.listModels()).map((m) => m.id);

    expect(ids).toEqual(['deepseek-experimental', 'deepseek-flash', 'deepseek-v4-pro']);
    expect(await executor.listModels()).toEqual(
      ids.map((id) => ({ id, efforts: ['off', 'low', 'high', 'max'] })),
    );
  });

  test('defaults the model and the effort', () => {
    expect(new DshExecutor({}).defaultModel).toBe('deepseek-flash');
    expect(new DshExecutor({}).defaultEffort).toBeUndefined();
    expect(new DshExecutor({ effort: 'high' }).defaultEffort).toBe('high');
  });
});

describe('DshExecutor finalMessage', () => {
  test('reads the final event out of the JSON stream', () => {
    const stdout = [
      JSON.stringify({ type: 'status', phase: 'step_start' }),
      JSON.stringify({ type: 'final', text: 'the answer' }),
    ].join('\n');
    expect(new DshExecutor({}).finalMessage(stdout)).toBe('the answer');
  });
});
