import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { FunctionCall } from '@/ai/types';
import type { Config } from '@/core/config';
import type { PermissionChecker } from '@/permission';
import type { ToolManager } from '@/tools/ToolManager';
import { SubAgentExecutor } from '../SubAgentExecutor';
import { SubAgentManager } from '../SubAgentManager';
import type { IToolRunner } from '../ToolRunner';
import { SubAgentType } from '../types';

/**
 * The parent run's LLM calls `spawn_subagent` once through the tool executor; every
 * later run (the child) just answers. Returns what the tool call produced.
 */
function createExecutor(manager: SubAgentManager, spawnArguments: Record<string, unknown>) {
  let runs = 0;
  let toolResult: unknown;
  const llmService = {
    generateWithTools: async (
      _messages: unknown,
      _tools: unknown,
      options: { toolExecutor: (call: FunctionCall) => Promise<unknown> },
    ) => {
      runs++;
      if (runs === 1) {
        toolResult = await options.toolExecutor({ name: 'spawn_subagent', arguments: JSON.stringify(spawnArguments) });
        return { text: 'parent done' };
      }
      return { text: 'child result' };
    },
  } as unknown as LLMService;
  const toolManager = { getToolsByScope: () => [], toToolDefinitions: () => [] } as unknown as ToolManager;
  const promptManager = {
    render: () => {
      throw new Error('no template');
    },
  } as unknown as PromptManager;
  const unusedToolRunner = {} as IToolRunner;
  const executor = new SubAgentExecutor(
    llmService,
    manager,
    toolManager,
    unusedToolRunner,
    promptManager,
    {} as PermissionChecker,
    { getAIConfig: () => undefined } as unknown as Config,
  );
  return { executor, getToolResult: () => toolResult };
}

describe('SubAgentExecutor spawn_subagent', () => {
  it('spawns a child of the running session, runs it and returns its output', async () => {
    const manager = new SubAgentManager();
    const { executor, getToolResult } = createExecutor(manager, {
      type: 'research',
      description: 'Research task',
      input: { q: 1 },
      waitForCompletion: true,
    });
    const parentId = await manager.spawn(undefined, SubAgentType.GENERIC, { description: 'parent', input: {} });

    await executor.execute(parentId);

    const [child] = manager.listByParent(parentId);
    expect(child.type).toBe(SubAgentType.RESEARCH);
    expect(child.task.description).toBe('Research task');
    expect(child.task.input).toEqual({ q: 1 });
    expect(child.status).toBe('completed');
    expect(getToolResult()).toEqual({ sessionId: child.id, status: 'completed', result: 'child result' });
  });

  it("passes the parent session's context to the child", async () => {
    const manager = new SubAgentManager();
    const { executor } = createExecutor(manager, { type: 'generic', description: 'd', waitForCompletion: true });
    const parentId = await manager.spawn(undefined, SubAgentType.GENERIC, {
      description: 'parent',
      input: {},
      parentContext: { userId: 999, groupId: 888, messageType: 'group' },
    });

    await executor.execute(parentId);

    const [child] = manager.listByParent(parentId);
    expect(child.context).toMatchObject({ userId: 999, groupId: 888, messageType: 'group' });
  });
});
