// ToolRunner - executes tool calls for SubAgent using ToolManager executors (no hooks)

import type { FunctionCall } from '@/ai/types';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { SubAgentManager } from './SubAgentManager';
import type { SubAgentSession, SubAgentType } from './types';

/**
 * Runs a single tool call in SubAgent context.
 * Uses ToolManager.getExecutor().execute() (no ToolManager.execute / no hooks).
 * Special-cases spawn_subagent via SubAgentManager.
 */
export interface IToolRunner {
  run(call: FunctionCall, session: SubAgentSession): Promise<unknown>;
}

export class ToolRunner implements IToolRunner {
  constructor(
    private toolManager: ToolManager,
    private subAgentManager: SubAgentManager,
    private hookManager: HookManager,
  ) {}

  async run(call: FunctionCall, session: SubAgentSession): Promise<unknown> {
    if (call.name === 'spawn_subagent') {
      return this.runSpawnSubAgent(call, session);
    }

    const toolSpec = this.toolManager.getTool(call.name);
    if (!toolSpec) {
      logger.warn(`[ToolRunner] No tool spec for: ${call.name}`);
      throw new Error(`Tool not found: ${call.name}`);
    }

    const executor = this.toolManager.getExecutor(toolSpec.executor);
    if (!executor) {
      logger.warn(`[ToolRunner] No executor for tool: ${call.name}`);
      throw new Error(`Executor not found for tool: ${call.name}`);
    }

    const toolCall: ToolCall = {
      type: call.name,
      parameters: this.parseArguments(call.arguments),
      executor: toolSpec.executor,
    };

    const hookContext = this.buildSyntheticHookContext(session);
    const context = this.buildToolContext(hookContext);
    const result = await this.toolManager.execute(toolCall, context, this.hookManager, hookContext);
    return this.normalizeResult(result);
  }

  private parseArguments(argumentsJson: string): Record<string, unknown> {
    try {
      return JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private buildToolContext(hookContext: HookContext): ToolExecutionContext {
    return ToolExecutionContextBuilder.fromHookContext(hookContext).withToolResults(new Map()).build();
  }

  private buildSyntheticHookContext(session: SubAgentSession): HookContext {
    const userId = Number(session.context.userId);
    const groupId = Number(session.context.groupId);
    const messageType = session.context.messageType ?? 'private';
    const isGroup = groupId !== 0;
    const metadata = createDefaultHookMetadata({
      sessionId: isGroup ? `group:${groupId}` : `user:${userId}`,
      sessionType: isGroup ? 'group' : 'user',
      userId,
      groupId,
      conversationId: session.context.conversationId ?? '',
    });

    const messageText = this.buildSyntheticMessageText(session);
    const syntheticMessage: NormalizedMessageEvent = {
      id: session.id,
      type: 'message',
      timestamp: session.startedAt?.getTime() ?? session.createdAt.getTime(),
      protocol: (session.context.protocol as NormalizedMessageEvent['protocol']) ?? 'milky',
      userId,
      groupId,
      messageType,
      message: messageText,
      messageId: this.parseMessageId(session.context.messageId),
      segments: [],
    };

    return {
      message: syntheticMessage,
      context: {
        userMessage: messageText,
        history: [],
        userId,
        groupId,
        messageType,
        metadata: new Map<string, unknown>([
          ['subAgentSessionId', session.id],
          ['subAgentType', session.type],
        ]),
      },
      metadata,
    };
  }

  private buildSyntheticMessageText(session: SubAgentSession): string {
    return `Sub-agent task: ${session.task.description}\n\nInput: ${JSON.stringify(session.task.input)}`;
  }

  private parseMessageId(messageId: string | undefined): number | undefined {
    if (!messageId) {
      return undefined;
    }
    const parsed = Number(messageId);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private normalizeResult(result: ToolResult): unknown {
    if (result.data !== undefined) {
      return result.data;
    }
    return result.reply ?? '';
  }

  private async runSpawnSubAgent(call: FunctionCall, session: SubAgentSession): Promise<unknown> {
    const args = this.parseArguments(call.arguments) as {
      type?: string;
      description?: string;
      input?: unknown;
      waitForCompletion?: boolean;
    };
    const type = (args.type ?? 'generic') as SubAgentType;
    const description = typeof args.description === 'string' ? args.description : '';
    const input = args.input ?? {};
    const waitForCompletion = args.waitForCompletion !== false;

    const parentId = session.id;
    const parentContext =
      session.context.userId !== undefined ||
      session.context.groupId !== undefined ||
      session.context.messageType !== undefined
        ? {
            userId: typeof session.context.userId === 'number' ? session.context.userId : 0,
            groupId: typeof session.context.groupId === 'number' ? session.context.groupId : undefined,
            messageType: (session.context.messageType ?? 'private') as 'private' | 'group',
            protocol: session.context.protocol,
            conversationId: session.context.conversationId,
            messageId: session.context.messageId,
          }
        : undefined;
    const sessionId = await this.subAgentManager.spawn(parentId, type, {
      description,
      input,
      parentContext,
    });

    if (waitForCompletion) {
      await this.subAgentManager.execute(sessionId);
      const output = await this.subAgentManager.wait(sessionId);
      return { sessionId, status: 'completed' as const, result: output };
    }

    void this.subAgentManager.execute(sessionId);
    return { sessionId, status: 'spawned' as const };
  }
}
