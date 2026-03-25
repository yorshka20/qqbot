// AgentLoop - LLM Q&A loop driven by scheduled intent (not by user message).
// Bot uses the schedule's intent as the "question" to the LLM; the loop runs multi-round (plan → tool calls → message) until the task is done, then sends the final reply.

import type { PromptManager } from '@/ai';
import type { AIService } from '@/ai/AIService';
import type { LLMService } from '@/ai/services/LLMService';
import { executeToolCall } from '@/ai/tools/replyTools';
import type { ChatMessage, ToolDefinition } from '@/ai/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { HookManager } from '@/hooks/HookManager';
import type { MessageSegment } from '@/message/types';
import type { ToolManager } from '@/tools/ToolManager';
import { getCurrentDateTimeForPrompt } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { buildAgendaHookContext } from './AgendaHookContext';
import type { AgendaEventContext, AgendaItem } from './types';

const DEFAULT_PROVIDER: string | undefined = undefined; // Use system default LLM provider

/**
 * AgentLoop
 *
 * Same shape as the normal reply LLM loop (user question → LLM + tools → reply), but the "question" is the schedule's intent.
 * toolManager and hookManager are required: the loop always uses generateWithTools and runs over multiple rounds to complete the task.
 * System prompt from template agenda.agent_loop_system (PromptManager).
 */
export class AgentLoop {
  private preferredProtocol: ProtocolName = 'milky';

  constructor(
    private llmService: LLMService,
    private messageAPI: MessageAPI,
    private conversationHistoryService: ConversationHistoryService,
    private promptManager: PromptManager,
    private toolManager: ToolManager,
    private hookManager: HookManager,
    private aiService?: AIService,
  ) {}

  setPreferredProtocol(protocol: ProtocolName): void {
    this.preferredProtocol = protocol;
  }

  /**
   * Execute an agenda item.
   * @param item - The agenda item to run
   * @param eventContext - Optional event context (for onEvent items)
   */
  async run(item: AgendaItem, eventContext: AgendaEventContext): Promise<void> {
    const groupId = item.groupId ?? eventContext?.groupId;
    const userId = item.userId ?? eventContext?.userId;
    const isPrivate = !groupId && !!userId;

    if (!groupId && !userId) {
      logger.warn(`[AgentLoop] Item "${item.name}" has no groupId or userId; skipping`);
      return;
    }

    const target = isPrivate ? `user ${userId}` : `group ${groupId}`;
    logger.info(`[AgentLoop] Running item "${item.name}" → ${target}`);

    const contextId = groupId ?? `private:${userId}`;
    const reply = await this.generateReply(item, contextId, eventContext);
    if (!reply) {
      logger.debug(`[AgentLoop] Item "${item.name}": no reply generated, skipping send`);
      return;
    }

    // Try card rendering for long/structured replies
    const cardResult = await this.tryRenderCard(reply, contextId);
    const message: string | MessageSegment[] = cardResult ?? reply;

    try {
      if (isPrivate) {
        await this.messageAPI.sendPrivateMessage(Number(userId), message, this.preferredProtocol);
      } else {
        await this.messageAPI.sendGroupMessage(Number(groupId), message, this.preferredProtocol);
      }
      logger.info(`[AgentLoop] Item "${item.name}": sent ${cardResult ? 'card image' : `${reply.length} chars`} → ${target}`);
    } catch (err) {
      logger.error(`[AgentLoop] Item "${item.name}": send failed`, err);
      throw err;
    }
  }

  // ─── Card Rendering ────────────────────────────────────────────────────────

  /**
   * Try to render reply text as a card image.
   * Returns segments on success, null on failure or if not suitable for card rendering.
   */
  private async tryRenderCard(reply: string, sessionId: string): Promise<MessageSegment[] | null> {
    if (!this.aiService) return null;
    try {
      const result = await this.aiService.processReplyMaybeCard(reply, sessionId);
      if (result) {
        logger.info('[AgentLoop] Reply rendered as card image');
        return result.segments;
      }
    } catch (err) {
      logger.warn('[AgentLoop] Card rendering failed, falling back to text:', err);
    }
    return null;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Run the LLM loop for this intent: build messages (intent as "user question"), then generateWithTools (multi-round) until done.
   */
  private async generateReply(
    item: AgendaItem,
    groupId: string,
    eventContext: AgendaEventContext,
  ): Promise<string | null> {
    const conversationContext = await this.fetchRecentContext(groupId);
    // Agenda tasks are system-level: include both reply and subagent scoped tools
    // so the LLM can access specialized tools (e.g. wechat_stats, wechat_report)
    const tools = this.getAgendaToolDefinitions();
    const toolInstruct = this.buildAgendaToolInstructions(tools);
    const messages = this.buildPrompt(item, conversationContext, eventContext, toolInstruct);

    try {
      const agendaContext = buildAgendaHookContext(item, groupId, eventContext);
      const toolExecutor = (call: { name: string; arguments: string }) =>
        executeToolCall(call, agendaContext, this.toolManager, this.hookManager);
      const response = await this.llmService.generateWithTools(
        messages,
        tools,
        {
          maxToolRounds: Math.max(1, item.maxSteps ?? 15),
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
   * Get tool definitions for agenda tasks (reply + subagent scopes merged).
   * Agenda tasks are system-level and need access to specialized tools like wechat_*.
   */
  private getAgendaToolDefinitions(): ToolDefinition[] {
    const replySpecs = this.toolManager.getToolsByScope('reply');
    const subagentSpecs = this.toolManager.getToolsByScope('subagent');
    const seen = new Set<string>();
    const merged = [...replySpecs, ...subagentSpecs].filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
    return this.toolManager.toToolDefinitions(merged);
  }

  /**
   * Build tool usage instructions for agenda tasks.
   */
  private buildAgendaToolInstructions(tools: ToolDefinition[]): string {
    if (tools.length === 0) {
      return this.promptManager.render('llm.tool.no_tools.local');
    }

    const replySpecs = this.toolManager.getToolsByScope('reply');
    const subagentSpecs = this.toolManager.getToolsByScope('subagent');
    const seen = new Set<string>();
    const allSpecs = [...replySpecs, ...subagentSpecs].filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
    const specsByName = new Map(allSpecs.map((s) => [s.name, s]));

    const toolList = tools
      .map((tool) => {
        const spec = specsByName.get(tool.name);
        const required = new Set(tool.parameters.required ?? []);
        const params = Object.entries(tool.parameters.properties ?? {})
          .map(([name, def]) => {
            const requiredLabel = required.has(name) ? '必填' : '可选';
            return `${name} (${def.type}，${requiredLabel})${def.description ? `: ${def.description}` : ''}`;
          })
          .join('; ');
        const usage = spec?.whenToUse?.trim();
        return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}`;
      })
      .join('\n');

    return this.promptManager.render('llm.tool.usage', { nativeSearchNote: '', toolList });
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
    const lines: string[] = [`当前时间: ${getCurrentDateTimeForPrompt()}`, `任务意图: ${item.intent}`];

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
