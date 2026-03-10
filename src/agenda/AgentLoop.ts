// AgentLoop - executes an AgendaItem's intent via LLM → send message pipeline
// Reuses LLMService (generateMessages) and ConversationHistoryService for context.

import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage } from '@/ai/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import type { ProtocolName } from '@/core/config/types/protocol';
import { logger } from '@/utils/logger';
import type { AgendaEventContext, AgendaItem } from './types';

const DEFAULT_PROVIDER: string | undefined = undefined; // Use system default LLM provider

/**
 * AgentLoop
 *
 * Executes one AgendaItem: builds context, calls LLM with the item's intent,
 * then sends the response to the target group.
 *
 * Cooldown and enabled-checks are done by AgendaService before calling run().
 *
 * Design principle: keep it thin. This is "the shell that translates intent to action."
 * Makes exactly one LLM call per run. The AgendaItem.maxSteps field is reserved for future
 * multi-step expansion (tool calls, follow-up actions), but is not used today.
 */
export class AgentLoop {
  private preferredProtocol: ProtocolName = 'milky';

  constructor(
    private llmService: LLMService,
    private messageAPI: MessageAPI,
    private conversationHistoryService: ConversationHistoryService,
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
   * Generate a reply for the given intent using the LLM.
   * Fetches recent conversation context, then makes one LLM call.
   */
  private async generateReply(
    item: AgendaItem,
    groupId: string,
    eventContext?: AgendaEventContext,
  ): Promise<string | null> {
    const conversationContext = await this.fetchRecentContext(groupId);
    const messages = this.buildPrompt(item, conversationContext, eventContext);

    try {
      const response = await this.llmService.generateMessages(messages, {}, DEFAULT_PROVIDER);
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
   */
  private buildPrompt(item: AgendaItem, conversationContext: string, eventContext?: AgendaEventContext): ChatMessage[] {
    const systemPrompt =
      '你是一个群聊机器人助手。你需要根据给定的任务意图，生成一条自然、合适的中文消息直接发送到群里。' +
      '直接输出消息内容本身，不要加引号、前缀或任何解释。';

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

    lines.push('', '请根据以上意图生成消息:');

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: lines.join('\n') },
    ];
  }
}
