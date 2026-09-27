import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import type { CodingAgentConfig } from '@/core/config';
import { CodingAgentTaskManager, type TaskProgressUpdate } from '../CodingAgentTaskManager';
import type { AgentExecutor } from '../executors';
import type { AgentInvocationInput } from '../executors/AgentExecutor';
import type { AgentTask } from '../types';

/** Runs the task's prompt as a shell script, so each test controls the process's output and lifetime. */
function shellExecutor(): AgentExecutor {
  return {
    name: 'codex',
    displayName: 'Shell',
    coAuthorTrailer: '',
    defaultModel: 'sh',
    async listModels() {
      return [];
    },
    async buildInvocation({ task }) {
      return { cmd: ['sh', '-c', task.prompt], env: { ...process.env }, cleanup: async () => {} };
    },
    finalMessage: (stdout) => stdout.trim(),
  };
}

function createManager(config: Partial<CodingAgentConfig> = {}) {
  const executor = shellExecutor();
  const manager = new CodingAgentTaskManager(
    { enabled: true, port: 0, idleTimeout: '1s', timeout: '1h', ...config },
    { claude: executor, codex: executor },
    'http://127.0.0.1:0/mcp',
  );
  const updates: AgentTask[] = [];
  const progress: TaskProgressUpdate[] = [];
  manager.setTaskUpdateCallback((task) => updates.push({ ...task }));
  manager.setTaskProgressCallback((_task, update) => progress.push(update));
  return { manager, updates, progress };
}

function run(manager: CodingAgentTaskManager, script: string, workingDirectory = tmpdir()) {
  const task = manager.createTask(script, { type: 'user', id: '10000001' }, workingDirectory, {
    executor: 'codex',
    model: 'sh',
  });
  manager.enqueueTask(task.id);
  return task;
}

describe('CodingAgentTaskManager watchdog', () => {
  test('a silent process is killed as stalled', async () => {
    const { manager } = createManager();
    const task = run(manager, 'sleep 30');
    const started = Date.now();
    const done = await manager.awaitTaskCompletion(task.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('判定卡死');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a process that keeps writing is not killed', async () => {
    const { manager } = createManager();
    const task = run(manager, 'for i in 1 2 3 4 5; do echo tick >&2; sleep 0.4; done; echo DONE');
    const done = await manager.awaitTaskCompletion(task.id);
    expect(done.status).toBe('completed');
    expect(done.result).toBe('DONE');
  });

  test('MCP activity counts as life', async () => {
    const { manager } = createManager();
    const task = run(manager, 'sleep 2; echo DONE');
    const keepAlive = setInterval(() => manager.touch(task.id), 300);
    const done = await manager.awaitTaskCompletion(task.id);
    clearInterval(keepAlive);
    expect(done.status).toBe('completed');
  });

  test('the total timeout applies even to an active process', async () => {
    const { manager } = createManager({ idleTimeout: '10s', timeout: '1s' });
    const task = run(manager, 'while true; do echo tick; sleep 0.2; done');
    const done = await manager.awaitTaskCompletion(task.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('运行超过');
  });

  test('a background child holding the pipe does not keep the task open', async () => {
    const { manager } = createManager({ idleTimeout: '30s' });
    const task = run(manager, '(sleep 30 &); echo DONE');
    const started = Date.now();
    const done = await manager.awaitTaskCompletion(task.id);
    expect(done.status).toBe('completed');
    expect(done.result).toBe('DONE');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('CodingAgentTaskManager lifecycle', () => {
  test('cancelling a running task finalizes it once and starts the next queued task once', async () => {
    const { manager, updates } = createManager({ idleTimeout: '30s' });
    const project = mkdtempSync(join(tmpdir(), 'coding-agent-test-'));
    const first = run(manager, 'sleep 30', project);
    const second = run(manager, 'echo SECOND', project);
    await Bun.sleep(200);
    expect(manager.cancelTask(first.id)).toBe(true);

    const done = await manager.awaitTaskCompletion(second.id);
    expect(done.result).toBe('SECOND');
    const firstFinal = updates.filter((u) => u.id === first.id && u.status === 'failed');
    expect(firstFinal).toHaveLength(1);
    expect(firstFinal[0].error).toBe('Task cancelled');
    expect(updates.filter((u) => u.id === second.id && u.status === 'running')).toHaveLength(1);
  });

  test('started / progress reports are relayed and a completed report does not finalize the task', async () => {
    const { manager, progress } = createManager({ idleTimeout: '30s' });
    const task = run(manager, 'sleep 0.5; echo DONE');
    await Bun.sleep(100);
    manager.handleTaskNotification({ taskId: task.id, status: 'started', message: '理解了任务' });
    manager.handleTaskNotification({ taskId: task.id, status: 'progress', message: '完成一半', progress: 50 });
    manager.handleTaskNotification({ taskId: task.id, status: 'completed', result: '早报的结果' });
    expect(manager.getTask(task.id)?.status).toBe('running');

    const done = await manager.awaitTaskCompletion(task.id);
    expect(done.result).toBe('DONE');
    expect(progress).toEqual([
      { status: 'started', message: '理解了任务', progress: undefined },
      { status: 'progress', message: '完成一半', progress: 50 },
    ]);
  });
});

describe('CodingAgentTaskManager workspace tasks', () => {
  function recordingManager(workspaceRoot: string) {
    const invocations: AgentInvocationInput[] = [];
    const executor: AgentExecutor = {
      ...shellExecutor(),
      async buildInvocation(input) {
        invocations.push(input);
        return { cmd: ['sh', '-c', 'sleep 0.3; echo DONE'], env: { ...process.env }, cleanup: async () => {} };
      },
    };
    const manager = new CodingAgentTaskManager(
      { enabled: true, port: 0, idleTimeout: '30s', workspaceRoot },
      { claude: executor, codex: executor },
      'http://127.0.0.1:0/mcp',
    );
    manager.setPromptManager(new PromptManager());
    return { manager, invocations };
  }

  function workspaceTask(manager: CodingAgentTaskManager, prompt: string) {
    const task = manager.createTask(prompt, { type: 'group', id: '10000001' }, '/should/be/ignored', {
      executor: 'codex',
      model: 'sh',
      taskType: 'workspace',
    });
    return { task, queue: manager.enqueueTask(task.id) };
  }

  test('each workspace task gets its own directory under the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-ws-'));
    const { manager } = recordingManager(root);
    const a = workspaceTask(manager, '调研甲').task;
    const b = workspaceTask(manager, '调研乙').task;
    expect(a.workingDirectory).toBe(join(root, a.id));
    expect(b.workingDirectory).toBe(join(root, b.id));
    expect(existsSync(join(root, a.id))).toBe(true);
  });

  test('workspace tasks share one serial queue', async () => {
    const { manager } = recordingManager(mkdtempSync(join(tmpdir(), 'coding-agent-ws-')));
    const first = workspaceTask(manager, '调研甲');
    const second = workspaceTask(manager, '调研乙');
    expect(first.queue.queuePosition).toBe(0);
    expect(second.queue.queuePosition).toBe(1);
    await manager.awaitTaskCompletion(second.task.id);
  });

  test('the prompt comes from the workspace template with the progress protocol filled in', async () => {
    const { manager, invocations } = recordingManager(mkdtempSync(join(tmpdir(), 'coding-agent-ws-')));
    const { task } = workspaceTask(manager, '对比甲乙两个方案');
    await manager.awaitTaskCompletion(task.id);
    const prompt = invocations[0].prompt;
    expect(prompt).toContain('和任何项目仓库都无关');
    expect(prompt).toContain('对比甲乙两个方案');
    expect(prompt).toContain(task.workingDirectory ?? '');
    expect(prompt).toContain('bot_notify_task');
    expect(prompt).not.toContain('{{');
  });
});
