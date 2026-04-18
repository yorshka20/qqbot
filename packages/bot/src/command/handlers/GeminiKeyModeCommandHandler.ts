import { injectable } from 'tsyringe';
import { type GeminiKeyMode, GeminiProvider } from '@/ai/providers/GeminiProvider';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Command to switch Gemini API key mode (free / paid) at runtime.
 * Only affects Gemini provider; model unchanged, key used for requests changes.
 */
@Command({
  name: 'gemini',
  description: 'Switch Gemini API key mode (free or paid). No arg to show current.',
  usage: '/gemini [free|paid]',
  permissions: ['admin'],
})
@injectable()
export class GeminiKeyModeCommandHandler implements CommandHandler {
  name = 'gemini';
  description = 'Switch Gemini API key mode (free or paid). No arg to show current.';
  usage = '/gemini [free|paid]';

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const messageBuilder = new MessageBuilder();

    if (args.length === 0) {
      const current = GeminiProvider.getKeyMode();
      messageBuilder.text(`当前 Gemini 密钥模式: ${current}`);
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }

    const mode = args[0].toLowerCase();
    if (mode !== 'free' && mode !== 'paid') {
      return {
        success: false,
        error: '无效模式，请使用 free 或 paid',
      };
    }

    GeminiProvider.setKeyMode(mode as GeminiKeyMode);
    messageBuilder.text(`已切换 Gemini 密钥模式为: ${mode}`);
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}
