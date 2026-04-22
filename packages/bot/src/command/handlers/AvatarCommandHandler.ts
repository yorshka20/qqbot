// AvatarCommandHandler — `/avatar <text>` feeds the text through Live2DPipeline
// (LLM reply in avatar voice + Live2D tag animations + TTS) and echoes the
// spoken text back to QQ as a plain segment (bypassing the card-rendering
// stage so long replies don't get sent as images).
//
// The pipeline is shared with the Bilibili danmaku bridge — see
// `services/live2d/Live2DPipeline.ts`. This handler only does transport
// glue: input validation, pipeline dispatch, and segment building.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { Live2DPipeline } from '@/services/live2d/Live2DPipeline';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'avatar',
  description:
    "Drive the Live2D avatar to say something. The LLM replies in the avatar's first-person voice; the reply is spoken via TTS and drives model animations — not rendered as a card image.",
  usage: '/avatar <text>',
  permissions: ['user'],
  aliases: [],
})
@injectable()
export class AvatarCommandHandler implements CommandHandler {
  name = 'avatar';
  description =
    "Drive the Live2D avatar to say something. The LLM replies in the avatar's first-person voice; the reply is spoken via TTS and drives model animations — not rendered as a card image.";
  usage = '/avatar <text>';

  /** Max input length; avatar replies are short by design. */
  private readonly MAX_INPUT_CHARS = 500;

  constructor(@inject(DITokens.LIVE2D_PIPELINE) private live2dPipeline: Live2DPipeline) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    void _context;
    const input = args.join(' ').trim();

    if (input.length === 0) {
      return {
        success: false,
        error: 'Usage: /avatar <text> — e.g. `/avatar 你好啊`',
      };
    }
    if (input.length > this.MAX_INPUT_CHARS) {
      return {
        success: false,
        error: `Input too long (${input.length} > ${this.MAX_INPUT_CHARS} chars). Keep it short — the reply is spoken aloud.`,
      };
    }

    const result = await this.live2dPipeline.enqueue({ text: input, source: 'avatar-cmd' });

    if (result.skipped) {
      // Surface the skip reason so the user knows why nothing came back
      // rather than getting a silent empty reply.
      const reasonText: Record<string, string> = {
        'avatar-inactive': 'Avatar 未启用或未初始化。',
        'no-consumer': '没有 avatar 消费端连接（VTS / preview）。',
        'prompt-render-failed': 'Avatar prompt 模板渲染失败。',
        'llm-failed': 'Avatar LLM 调用失败。',
        'empty-reply': 'Avatar LLM 返回空回复。',
        'bad-llm-reply': 'Avatar LLM 返回了无效内容（已拒绝，请重试）。',
      };
      const reason = (result.skipReason && reasonText[result.skipReason]) || 'Avatar 流水线未执行。';
      logger.warn(`[AvatarCommandHandler] pipeline skipped: ${result.skipReason}`);
      return { success: false, error: reason };
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(result.spoken.length > 0 ? result.spoken : result.replyText);

    return {
      success: true,
      segments: messageBuilder.build(),
      sentAsForward: false,
    };
  }
}
