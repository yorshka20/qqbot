// AgentLoop - LLM Q&A loop driven by scheduled intent (not by user message).
// Bot uses the schedule's intent as the "question" to the LLM; the loop runs multi-round (plan → tool calls → message) until the task is done, then sends the final reply.

import type { PromptManager } from '@/ai';
import type { LLMService } from '@/ai/services/LLMService';
import { buildToolUsageInstructions, executeToolCall, getReplyToolDefinitions } from '@/ai/tools/replyTools';
import type { ChatMessage } from '@/ai/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { HookManager } from '@/hooks/HookManager';
import type { TaskManager } from '@/task/TaskManager';
import { logger } from '@/utils/logger';
import { buildAgendaHookContext } from './AgendaHookContext';
import type { AgendaEventContext, AgendaItem } from './types';

const DEFAULT_PROVIDER: string | undefined = undefined; // Use system default LLM provider

/**
 * AgentLoop
 *
 * Same shape as the normal reply LLM loop (user question → LLM + tools → reply), but the "question" is the schedule's intent.
 * taskManager and hookManager are required: the loop always uses generateWithTools and runs over multiple rounds to complete the task.
 * System prompt from template agenda.agent_loop_system (PromptManager).
 */
export class AgentLoop {
  private preferredProtocol: ProtocolName = 'milky';

  constructor(
    private llmService: LLMService,
    private messageAPI: MessageAPI,
    private conversationHistoryService: ConversationHistoryService,
    private promptManager: PromptManager,
    private taskManager: TaskManager,
    private hookManager: HookManager,
  ) {}

  setPreferredProtocol(protocol: ProtocolName): void {
    this.preferredProtocol = protocol;
  }

  /**
   * Execute an agenda item.
   * @param item - The agenda item to run
   * @param eventContext - Optional event context (for onEvent items)
   */
  async run(item: AgendaItem, eventContext?: AgendaEventContext): Promise<void> {
    const groupId = item.groupId ?? eventContext?.groupId;
    if (!groupId) {
      logger.warn(`[AgentLoop] Item "${item.name}" has no groupId; skipping`);
      return;
    }

    logger.info(`[AgentLoop] Running item "${item.name}" → group ${groupId}`);

    const reply = await this.generateReply(item, groupId, eventContext);
    if (!reply) {
      logger.debug(`[AgentLoop] Item "${item.name}": no reply generated, skipping send`);
      return;
    }

    try {
      await this.messageAPI.sendGroupMessage(Number(groupId), reply, this.preferredProtocol);
      logger.info(`[AgentLoop] Item "${item.name}": sent ${reply.length} chars → group ${groupId}`);
    } catch (err) {
      logger.error(`[AgentLoop] Item "${item.name}": send failed`, err);
      throw err;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Run the LLM loop for this intent: build messages (intent as "user question"), then generateWithTools (multi-round) until done.
   */
  private async generateReply(
    item: AgendaItem,
    groupId: string,
    eventContext?: AgendaEventContext,
  ): Promise<string | null> {
    const conversationContext = await this.fetchRecentContext(groupId);
    const tools = getReplyToolDefinitions(this.taskManager);
    const toolInstruct = buildToolUsageInstructions(this.taskManager, tools);
    const messages = this.buildPrompt(item, conversationContext, eventContext, toolInstruct);

    try {
      const agendaContext = buildAgendaHookContext(item, groupId, eventContext);
      const toolExecutor = (call: { name: string; arguments: string }) =>
        executeToolCall(call, agendaContext, this.taskManager, this.hookManager);
      const response = await this.llmService.generateWithTools(
        messages,
        tools,
        {
          maxToolRounds: Math.max(1, item.maxSteps ?? 3),
          toolExecutor,
        },
        DEFAULT_PROVIDER,
      );
      return response.text?.trim() || null;
    } catch (err) {
      logger.error(`[AgentLoop] LLM call failed for item "${item.name}":`, err);
      return null;
    }
  }

  /**
   * Fetch last 15 messages from the group for context injection.
   * Returns empty string on failure (graceful degradation).
   */
  private async fetchRecentContext(groupId: string): Promise<string> {
    try {
      const { groupIdNum } = normalizeGroupId(groupId);
      const entries = await this.conversationHistoryService.getRecentMessages(groupIdNum, 15);
      if (!entries.length) return '';

      return entries
        .slice(-10) // cap at 10 for prompt size
        .map((e) => {
          const role = e.isBotReply ? 'Bot' : `User(${e.userId})`;
          return `${role}: ${e.content}`;
        })
        .join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Build the ChatMessage[] prompt for the LLM.
   * System prompt from template agenda.agent_loop_system with toolInstruct.
   */
  private buildPrompt(
    item: AgendaItem,
    conversationContext: string,
    eventContext: AgendaEventContext | undefined,
    toolInstruct: string,
  ): ChatMessage[] {
    const systemPrompt = this.promptManager.render('agenda.agent_loop_system', { toolInstruct });
    const lines: string[] = [`任务意图: ${item.intent}`];

    if (eventContext) {
      lines.push(`触发事件: ${eventContext.eventType}`);
      if (eventContext.userId) {
        lines.push(`相关用户: ${eventContext.userId}`);
      }
      if (eventContext.data && Object.keys(eventContext.data).length > 0) {
        lines.push(`事件数据: ${JSON.stringify(eventContext.data)}`);
      }
    }

    if (conversationContext) {
      lines.push('', '近期群聊记录:', conversationContext);
    }

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: lines.join('\n') },
    ];
  }
}
