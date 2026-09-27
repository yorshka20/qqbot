import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { HookManager } from '@/hooks/HookManager';
import { resolveConversationScope } from '@/tools/executors/conversationScope';
import { ToolManager } from '@/tools/ToolManager';
import type { ToolExecutionContext, ToolSpec } from '@/tools/types';
import { AgentToolBridge } from '../AgentToolBridge';
import { toZodShape } from '../CodingAgentMcpServer';
import type { AgentTask } from '../types';

const PARAMS: ToolSpec['parameters'] = {
  keyword: { type: 'string', required: true, description: '关键词' },
};

function bridgeWith(specs: ToolSpec[]) {
  const toolManager = new ToolManager();
  const calls: Array<{ name: string; context: ToolExecutionContext }> = [];
  for (const spec of specs) {
    toolManager.registerTool(spec);
    toolManager.registerExecutor({
      name: spec.executor,
      execute: (call, context) => {
        calls.push({ name: call.type, context });
        return { success: true, reply: `ran ${call.type}` };
      },
    });
  }
  const hookManager = { execute: async () => true } as unknown as HookManager;
  return { bridge: new AgentToolBridge(toolManager, hookManager), calls };
}

function task(requestedBy: AgentTask['requestedBy']): AgentTask {
  return {
    id: 'task-1',
    executor: 'codex',
    model: 'm',
    prompt: '调研',
    createdAt: new Date(),
    status: 'running',
    requestedBy,
    taskType: 'workspace',
  };
}

const SPECS: ToolSpec[] = [
  { name: 'history', description: 'd', executor: 'history', visibility: { reply: true, agent: true }, parameters: PARAMS },
  {
    name: 'admin_tool',
    description: 'd',
    executor: 'admin_tool',
    visibility: { reply: { adminOnly: true }, agent: true },
    parameters: PARAMS,
  },
  { name: 'subagent_only', description: 'd', executor: 'subagent_only', visibility: { subagent: true } },
];

describe('AgentToolBridge', () => {
  test('only agent-scoped tools that are not adminOnly are offered', () => {
    const { bridge } = bridgeWith(SPECS);
    expect(bridge.listTools().map((t) => t.name)).toEqual(['history']);
  });

  test('a call from a group task runs in that group, as the requester', async () => {
    const { bridge, calls } = bridgeWith(SPECS);
    const result = await bridge.call(task({ type: 'group', id: '10000002', userId: '10000001' }), 'milky', 'history', {
      keyword: 'x',
    });
    expect(result).toMatchObject({ success: true, reply: 'ran history' });
    expect(resolveConversationScope(calls[0].context)).toEqual({
      sessionId: 'group:10000002',
      sessionType: 'group',
      groupId: '10000002',
    });
    expect(String(calls[0].context.userId)).toBe('10000001');
  });

  test('a call from a private task runs in that private chat', async () => {
    const { bridge, calls } = bridgeWith(SPECS);
    await bridge.call(task({ type: 'user', id: '10000001' }), 'milky', 'history', { keyword: 'x' });
    expect(resolveConversationScope(calls[0].context)).toEqual({ sessionId: 'user:10000001', sessionType: 'user' });
  });

  test('a tool outside the agent scope is refused without running', async () => {
    const { bridge, calls } = bridgeWith(SPECS);
    for (const name of ['admin_tool', 'subagent_only', 'missing']) {
      const result = await bridge.call(task({ type: 'group', id: '10000002' }), 'milky', name, {});
      expect(result.success).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('toZodShape', () => {
  test('required, optional and enum parameters survive the conversion', () => {
    const schema = z.object(
      toZodShape({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'q' },
          limit: { type: 'number' },
          mode: { type: 'string', enum: ['a', 'b'] },
        },
        required: ['query'],
      }),
    );
    expect(schema.safeParse({ query: 'x' }).success).toBe(true);
    expect(schema.safeParse({ query: 'x', limit: 3, mode: 'b' }).success).toBe(true);
    expect(schema.safeParse({ limit: 3 }).success).toBe(false);
    expect(schema.safeParse({ query: 'x', mode: 'c' }).success).toBe(false);
  });
});
