// ToolRunner - executes tool calls for SubAgent through ToolManager.execute

import { inject, singleton } from 'tsyringe';
import type { FunctionCall } from '@/ai/types';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import { deriveSourceFromEvent } from '@/conversation/sources';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import { HookManager } from '@/hooks/HookManager';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { SubAgentSession } from './types';

/**
 * Runs a single tool call in SubAgent context.
 * Goes through ToolManager.execute, so tool hooks (onToolBeforeExecute /
 * onToolExecuted) DO fire — on a synthetic hook context whose
 * `context.metadata` carries `subAgentSessionId`, which is how session-level
 * hook consumers (e.g. the audit ledger) tell subagent-internal calls apart.
 * `spawn_subagent` never reaches here: SubAgentExecutor handles it itself.
 */
export interface IToolRunner {
  run(call: FunctionCall, session: SubAgentSession): Promise<unknown>;
}

@singleton()
export class ToolRunner implements IToolRunner {
  constructor(
    @inject(DITokens.TOOL_MANAGER) private toolManager: ToolManager,
    @inject(HookManager) private hookManager: HookManager,
  ) {}

  async run(call: FunctionCall, session: SubAgentSession): Promise<unknown> {
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
      source: deriveSourceFromEvent(syntheticMessage),
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
    // Per ToolResult contract: `reply` is the authoritative LLM-facing message.
    // Fall back to `data` only when reply is empty so non-trivial `data` cannot
    // silently shadow real content (cf. the research-subagent regression).
    if (result.reply) {
      return result.reply;
    }
    return result.data ?? '';
  }
}
