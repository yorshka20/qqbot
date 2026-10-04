import { inject, injectable } from 'tsyringe';
import { EpisodeCacheManager } from '@/ai/pipeline/helpers/EpisodeCacheManager';
import { normalizeSessionId } from '@/conversation/history';
import { getSessionId } from '@/core/config/SessionUtils';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

const DESCRIPTION = '压缩本会话的上下文：旧对话压成一段摘要；加 clear 则直接清空，从现在重新开始';
const USAGE = '/compress [clear]';

@Command({
  name: 'compress',
  description: DESCRIPTION,
  usage: USAGE,
  permissions: ['user'],
  aliases: ['compact', '压缩'],
})
@injectable()
export class CompressCommandHandler implements CommandHandler {
  name = 'compress';
  description = DESCRIPTION;
  usage = USAGE;

  constructor(@inject(EpisodeCacheManager) private episodeCache: EpisodeCacheManager) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const sessionId = normalizeSessionId(getSessionId(context), context.messageType === 'group' ? 'group' : 'user');
    const mode = args[0]?.trim().toLowerCase();
    if (mode != null && mode !== 'clear') {
      return { success: false, error: `用法：${USAGE}` };
    }

    if (mode === 'clear') {
      this.episodeCache.clearSession(sessionId, new Date());
      return this.reply('上下文已清空，从这条往后重新算起。');
    }

    const result = await this.episodeCache.compressSession(sessionId, new Date());
    switch (result.status) {
      case 'compressed':
        return this.reply(
          `已压缩：${result.foldedEntries} 条旧消息并成一段摘要，上下文 ${formatChars(result.charsBefore)} → ${formatChars(result.charsAfter)} 字。`,
        );
      case 'no-window':
        return this.reply('现在没有进行中的上下文，下一轮会从最近几条消息重新开始。');
      case 'too-short':
        return this.reply(`上下文只有 ${result.entries} 条，不用压缩。`);
      case 'busy':
        return this.reply('后台正在压缩这段上下文，稍后再试。');
      case 'failed':
        return {
          success: false,
          error: '压缩没成功（摘要为空或上下文刚变动），上下文保持原样。可以再试一次，或用 /compress clear 直接清空。',
        };
    }
  }

  private reply(text: string): CommandResult {
    return { success: true, segments: new MessageBuilder().text(text).build() };
  }
}

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}K` : String(chars);
}
