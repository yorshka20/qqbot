import { injectable } from 'tsyringe';
import type { AgendaService } from '@/agenda/AgendaService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { getChainDepth } from './ScheduleTaskToolExecutor';

@Tool({
  name: 'watch_messages',
  description:
    '注册一个临时的消息监听：接下来当前会话里出现匹配的消息（包含关键词，或来自指定用户）时，bot 会以你写下的 prompt 为指令被唤起执行。监听是非永久的：默认 24 小时后自动失效，默认触发 1 次后失效（最多可设 10 次）。',
  executor: 'watch_messages',
  visibility: {
    reply: { sources: ['qq-group', 'qq-private', 'discord'] },
  },
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description:
        '触发时给自己的任务指令。触发时你能看到命中的那条消息，但看不到现在的对话，所以要把背景写进来（例如"有人提到明天的比赛时，把下午整理的赛程发出来"）。',
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
      description: '只监听该用户的消息（QQ 号）。可与 keywords 组合；两者至少提供一个。',
    },
    max_fires: {
      type: 'number',
      required: false,
      description: '触发次数上限，达到后监听失效。默认 1，最多 10。',
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
  whenToUse: '用户希望 bot 在接下来一段时间内关注特定话题或特定人的发言，并在出现时做出反应时调用。',
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
    const userIdParam = typeof call.parameters?.user_id === 'string' ? call.parameters.user_id.trim() : undefined;
    const maxFires = typeof call.parameters?.max_fires === 'number' ? call.parameters.max_fires : undefined;
    const ttlHours = typeof call.parameters?.ttl_hours === 'number' ? call.parameters.ttl_hours : undefined;
    const name = typeof call.parameters?.name === 'string' ? call.parameters.name : undefined;

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
}
