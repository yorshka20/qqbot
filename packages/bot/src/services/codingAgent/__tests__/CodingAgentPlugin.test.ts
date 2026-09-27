import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { CommandContext, CommandResult } from '@/command/types';
import type { CodingAgentService, TriggerTaskOptions } from '../CodingAgentService';
import { CodingAgentPlugin } from '../plugins/CodingAgentPlugin';
import type { AgentExecutorName } from '../types';

interface PluginInternals {
  agentService: CodingAgentService;
  executeCommand(executor: AgentExecutorName, args: string[], context: CommandContext): Promise<CommandResult>;
}

function pluginWithService() {
  const triggered: Array<{ workingDirectory?: string; options?: TriggerTaskOptions }> = [];
  const service = {
    getProjectRegistry: () => ({
      resolve: (id?: string) =>
        id === 'qqbot' ? { alias: 'qqbot', path: '/repo/qqbot', type: 'bun', hasClaudeMd: true } : null,
    }),
    getExecutor: () => ({ displayName: 'Codex' }),
    triggerTask: async (_prompt: string, _by: unknown, workingDirectory?: string, options?: TriggerTaskOptions) => {
      triggered.push({ workingDirectory, options });
      return { id: 'task-0001', status: 'running', queuePosition: 0, model: 'm' };
    },
  } as unknown as CodingAgentService;
  const plugin = new CodingAgentPlugin({ name: 'codingAgent', version: 'test', description: 'test' });
  const internals = plugin as unknown as PluginInternals;
  internals.agentService = service;
  return { internals, triggered };
}

const CONTEXT = {
  messageType: 'group',
  groupId: 10000002,
  userId: 10000001,
  originalMessage: { messageId: 1 },
} as unknown as CommandContext;

describe('CodingAgentPlugin task routing', () => {
  test('a task without @project runs in a workspace, not in any repository', async () => {
    const { internals, triggered } = pluginWithService();
    const result = await internals.executeCommand('codex', ['做一个', '简单网页'], CONTEXT);
    expect(result.success).toBe(true);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].workingDirectory).toBeUndefined();
    expect(triggered[0].options?.taskType).toBe('workspace');
    expect(triggered[0].options?.projectContext).toBeUndefined();
  });

  test('@project makes it a dev task in that project', async () => {
    const { internals, triggered } = pluginWithService();
    await internals.executeCommand('codex', ['@qqbot', '修一下', 'bug'], CONTEXT);
    expect(triggered[0].workingDirectory).toBe('/repo/qqbot');
    expect(triggered[0].options?.taskType).toBe('dev');
    expect(triggered[0].options?.projectContext?.alias).toBe('qqbot');
  });

  test('an unknown @project is refused instead of falling back to a default project', async () => {
    const { internals, triggered } = pluginWithService();
    const result = await internals.executeCommand('codex', ['@nope', '任务'], CONTEXT);
    expect(result.success).toBe(false);
    expect(triggered).toHaveLength(0);
  });
});
