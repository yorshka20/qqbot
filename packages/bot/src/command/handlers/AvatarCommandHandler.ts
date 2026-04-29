// AvatarCommandHandler — `/avatar <text>` feeds the text through MessagePipeline
// (LLM reply in avatar voice + Live2D tag animations + TTS) and echoes the
// spoken text back to QQ as a plain segment (bypassing the card-rendering
// stage so long replies don't get sent as images).

import { inject, injectable } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessagePipeline } from '@/conversation/MessagePipeline';
import type { MessageProcessingContext } from '@/conversation/types';
import { makeSyntheticEvent } from '@/conversation/synthetic';
import type { ReplyContent } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
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

  constructor(
    @inject(DITokens.MESSAGE_PIPELINE) private messagePipeline: MessagePipeline,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
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

    const event = makeSyntheticEvent({
      source: 'avatar-cmd',
      userId: String(_context.userId),
      groupId: null,
      text: input,
      messageType: _context.messageType,
      protocol: _context.metadata.protocol,
    });

    let captured: ReplyContent | null = null;
    const procContext: MessageProcessingContext = {
      message: event,
      sessionId: `avatar-cmd-${event.id}`,
      sessionType: 'user',
      botSelfId: String(this.config.getBotUserId() ?? ''),
      source: 'avatar-cmd',
      responseCallback: (reply) => { captured = reply; },
    };

    try {
      const result = await this.messagePipeline.process(event, procContext, 'avatar-cmd');
      if (!result.success) {
        logger.warn(`[AvatarCommandHandler] pipeline failed: ${result.error}`);
        return { success: false, error: 'Avatar 流水线未执行（pipeline error）。' };
      }
      // TypeScript cannot narrow `captured` through the closure guard, so
      // the null check covers runtime and the cast covers the type system.
      if (captured === null) {
        logger.warn('[AvatarCommandHandler] pipeline succeeded but no responseCallback fired');
        return { success: false, error: 'Avatar 流水线未返回回复。' };
      }

      const replyText = (captured as ReplyContent).segments
        .filter((s: MessageSegment) => s.type === 'text')
        .map((s) => (s.data as { text: string }).text)
        .join('');
      const messageBuilder = new MessageBuilder();
      messageBuilder.text(replyText);

      return { success: true, segments: messageBuilder.build(), sentAsForward: false };
    } catch (err) {
      logger.warn('[AvatarCommandHandler] pipeline threw:', err);
      return { success: false, error: 'Avatar 流水线异常。' };
    }
  }
}
