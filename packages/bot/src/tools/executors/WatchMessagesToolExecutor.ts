import { injectable } from 'tsyringe';
import type { AgendaService } from '@/agenda/AgendaService';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { resolveConversationScope } from './conversationScope';
import { getChainDepth } from './ScheduleTaskToolExecutor';
import { resolveSender, SENDER_PARAM_DESCRIPTIONS } from './senderResolution';

@Tool({
  name: 'watch_messages',
  description:
    '注册一个临时的消息监听：接下来当前会话里出现匹配的消息（包含关键词，或来自指定用户）时，bot 会带着那条消息、以你写下的 prompt 为指令被唤起，结合它现场组织回应。监听是非永久的：默认 24 小时后自动失效，默认触发 1 次后失效（最多可设 100 次）。',
  executor: 'watch_messages',
  visibility: {
    reply: { sources: ['qq-group', 'qq-private', 'discord'] },
  },
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description:
        '触发时给自己的任务指令：写「要达成什么效果」——话题、切入角度，以及现在知道、将来查不到的背景事实（触发时你能看到命中的那条消息和近期聊天记录，但看不到现在这轮对话）。命中的消息事先不可知，回应必须结合它现场发挥，所以不要写好成品文案让未来的自己复述。例：写"有人再提到明天的比赛时，提醒他们下午接龙的名单还差两个人，语气轻松"，而不是写"输出这句话：『……』"。',
    },
    keywords: {
      type: 'array',
      required: false,
      items: { type: 'string' },
      description: '要监听的关键词列表（任一命中即触发，忽略大小写）。每个 2-20 字符，最多 5 个。',
    },
    user_id: {
      type: 'string',
      required: false,
      description: `只监听该用户的消息。${SENDER_PARAM_DESCRIPTIONS.userId} 可与 keywords 组合；两者至少提供一个。`,
    },
    nickname: {
      type: 'string',
      required: false,
      description: `只监听该用户的消息，但手上只有名字时用这个。${SENDER_PARAM_DESCRIPTIONS.nickname}`,
    },
    max_fires: {
      type: 'number',
      required: false,
      description: '触发次数上限，达到后监听失效。默认 1，最多 100。',
    },
    ttl_hours: {
      type: 'number',
      required: false,
      description: '有效期（小时），过期未触发则自动失效。默认 24，最多 72。',
    },
    name: {
      type: 'string',
      required: false,
      description: '监听的简短名称，便于管理。',
    },
  },
  examples: ['接下来有人说"开饭"就提醒他们带伞', '留意用户 12345 的下一条消息并转告我'],
  whenToUse:
    '用户希望 bot 在接下来一段时间内关注特定话题或特定人的发言，并在出现时做出反应时调用。想让 bot"到时候说某句固定的话"也用它，但 prompt 里写的是那句话想表达的意思和背景，措辞留给触发时的自己。',
})
@injectable()
export class WatchMessagesToolExecutor extends BaseToolExecutor {
  name = 'watch_messages';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const prompt = typeof call.parameters?.prompt === 'string' ? call.parameters.prompt : '';
    const keywordsParam = call.parameters?.keywords;
    const keywords = Array.isArray(keywordsParam)
      ? keywordsParam.filter((k): k is string => typeof k === 'string')
      : undefined;
    const maxFires = typeof call.parameters?.max_fires === 'number' ? call.parameters.max_fires : undefined;
    const ttlHours = typeof call.parameters?.ttl_hours === 'number' ? call.parameters.ttl_hours : undefined;
    const name = typeof call.parameters?.name === 'string' ? call.parameters.name : undefined;

    const watchTarget = await this.resolveWatchTarget(call, context);
    if (watchTarget && 'error' in watchTarget) {
      return watchTarget.error;
    }
    const userIdParam = watchTarget?.userId;

    if (context.messageType === 'private' && userIdParam) {
      return this.error('私聊会话只会监听当前用户，无需指定 user_id', 'user_id not applicable in private chat');
    }

    const agendaService = getContainer().resolve<AgendaService>(DITokens.AGENDA_SERVICE);
    const result = await agendaService.createLlmItem({
      kind: 'onMessage',
      prompt,
      name,
      groupId: context.messageType === 'group' ? context.groupId?.toString() : undefined,
      userId: context.userId.toString(),
      keywords,
      watchUserId: userIdParam || undefined,
      ttlMs: ttlHours !== undefined ? ttlHours * 3600_000 : undefined,
      maxFires,
      chainDepth: getChainDepth(context),
    });

    if (!result.ok) {
      return this.error(`消息监听注册失败：${result.error}`, result.error);
    }

    logger.info(`[WatchMessagesToolExecutor] createLlmItem success | result=${JSON.stringify(result.item)}`);

    return this.success(
      `已注册消息监听「${result.item.name}」：触发上限 ${result.item.maxFires} 次，${result.item.expiresAt} 过期。`,
      { itemId: result.item.id, expiresAt: result.item.expiresAt, maxFires: result.item.maxFires },
    );
  }

  /** Settle `user_id` / `nickname` into the QQ id the watch filters on. */
  private async resolveWatchTarget(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<{ userId: string } | { error: ToolResult } | null> {
    const params = { userId: call.parameters?.user_id, nickname: call.parameters?.nickname };
    const scope = resolveConversationScope(context);
    if (!scope) {
      const raw = params.userId;
      const direct = typeof raw === 'string' ? raw.trim() : '';
      return direct ? { userId: direct } : null;
    }

    const history = getContainer().resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
    const resolution = await resolveSender(history, scope, params);
    switch (resolution.kind) {
      case 'resolved':
        return { userId: resolution.userId };
      case 'not_found':
      case 'ambiguous':
        return { error: this.success(resolution.message, { nickname: resolution.nickname }) };
      default:
        return null;
    }
  }
}
