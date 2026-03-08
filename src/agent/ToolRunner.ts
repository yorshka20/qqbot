// ToolRunner - executes tool calls for SubAgent using TaskManager executors (no hooks)

import type { FunctionCall } from '@/ai/types';
import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskExecutionContext, TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';
import type { SubAgentManager } from './SubAgentManager';
import type { SubAgentSession, SubAgentType } from './types';

/**
 * Runs a single tool call in SubAgent context.
 * Uses TaskManager.getExecutor().execute() (no TaskManager.execute / no hooks).
 * Special-cases spawn_subagent via SubAgentManager.
 */
export interface IToolRunner {
  run(call: FunctionCall, session: SubAgentSession): Promise<unknown>;
}

export class ToolRunner implements IToolRunner {
  constructor(
    private taskManager: TaskManager,
    private subAgentManager: SubAgentManager,
    private hookManager: HookManager,
  ) {}

  async run(call: FunctionCall, session: SubAgentSession): Promise<unknown> {
    if (call.name === 'spawn_subagent') {
      return this.runSpawnSubAgent(call, session);
    }

    const task: Task = {
      type: call.name,
      parameters: this.parseArguments(call.arguments),
      executor: call.name,
    };

    const taskType = this.taskManager.getTaskType(call.name);
    if (!taskType) {
      logger.warn(`[ToolRunner] No task type for tool: ${call.name}`);
      throw new Error(`Task type not found for tool: ${call.name}`);
    }

    const executor = this.taskManager.getExecutor(taskType.executor);
    if (!executor) {
      logger.warn(`[ToolRunner] No executor for tool: ${call.name}`);
      throw new Error(`Executor not found for tool: ${call.name}`);
    }

    const hookContext = this.buildSyntheticHookContext(session);
    const context = this.buildTaskContext(hookContext);
    const result = await this.taskManager.execute(task, context, this.hookManager, hookContext);
    return this.normalizeResult(result);
  }

  private parseArguments(argumentsJson: string): Record<string, unknown> {
    try {
      return JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private buildTaskContext(hookContext: HookContext): TaskExecutionContext {
    return TaskExecutionContextBuilder.fromHookContext(hookContext).withTaskResults(new Map()).build();
  }

  private buildSyntheticHookContext(session: SubAgentSession): HookContext {
    const userId = typeof session.context.userId === 'number' ? session.context.userId : 0;
    const groupId = typeof session.context.groupId === 'number' ? session.context.groupId : undefined;
    const messageType = session.context.messageType ?? 'private';
    const metadata = new HookMetadataMap();
    metadata.set('sessionId', groupId !== undefined ? `group:${groupId}` : `user:${userId}`);
    metadata.set('sessionType', groupId !== undefined ? 'group' : 'user');
    metadata.set('userId', userId);
    if (groupId !== undefined) {
      metadata.set('groupId', groupId);
    }
    if (session.context.conversationId) {
      metadata.set('conversationId', session.context.conversationId);
    }

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

  private normalizeResult(result: TaskResult): unknown {
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
