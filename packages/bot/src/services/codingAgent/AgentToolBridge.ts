/**
 * Lets a coding agent call the bot's own tools — chat history, memory, the
 * knowledge base: data a local CLI cannot reach by itself. Only tools declaring
 * the `agent` visibility scope are offered, and each call runs as if made in
 * the conversation that requested the task, so an agent sees that chat's data
 * and nothing else.
 */

import { inject, singleton } from 'tsyringe';
import type { ToolDefinition } from '@/ai/types';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import type { ProtocolName } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { HookManager } from '@/hooks/HookManager';
import { buildSyntheticHookContext } from '@/hooks/syntheticHookContext';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolResult } from '@/tools/types';
import type { AgentTask } from './types';

@singleton()
export class AgentToolBridge {
  constructor(
    @inject(DITokens.TOOL_MANAGER) private readonly toolManager: ToolManager,
    @inject(HookManager) private readonly hookManager: HookManager,
  ) {}

  /** Definitions with the same composed description the chat LLM sees. */
  listTools(): ToolDefinition[] {
    return this.toolManager.toToolDefinitions(this.toolManager.getToolsByScope('agent'));
  }

  async call(
    task: AgentTask,
    protocol: ProtocolName,
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolResult> {
    const spec = this.toolManager.getToolsByScope('agent').find((t) => t.name === name);
    if (!spec) {
      return { success: false, reply: `Tool ${name} is not available to agents`, error: 'tool not available' };
    }

    const isGroup = task.requestedBy.type === 'group';
    const hookContext = buildSyntheticHookContext({
      id: `coding-agent-${task.id}`,
      timestamp: Date.now(),
      protocol,
      userId: Number(isGroup ? (task.requestedBy.userId ?? 0) : task.requestedBy.id),
      groupId: isGroup ? Number(task.requestedBy.id) : 0,
      messageType: isGroup ? 'group' : 'private',
      messageText: `Coding agent task: ${task.prompt}`,
      contextMetadata: new Map<string, unknown>([['codingAgentTaskId', task.id]]),
    });
    const context = ToolExecutionContextBuilder.fromHookContext(hookContext).withToolResults(new Map()).build();
    return this.toolManager.execute(
      { type: name, parameters, executor: spec.executor },
      context,
      this.hookManager,
      hookContext,
    );
  }
}
