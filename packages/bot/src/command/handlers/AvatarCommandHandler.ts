// AvatarCommandHandler — `/avatar <text>` invokes the LLM to reply in the
// avatar's first-person voice, drives Live2D tags, and speaks the reply via
// the renderer-side pipeline.
//
// This command is the **only** path that triggers SpeechService-driven TTS —
// the Live2DAvatarPlugin no longer auto-speaks every private AI reply, which
// used to pull in CardRenderingService on long replies and send text as
// images. By going through the command pipeline instead, the bot returns
// plain text segments directly (no card render, no forward-message) so the
// audio + lip-sync path is exercised cleanly.

import type { AvatarService } from '@qqbot/avatar';
import { parseLive2DTags, stripLive2DTags } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'avatar',
  description:
    'Drive the Live2D avatar to say something. The LLM replies in the avatar\'s first-person voice; the reply is spoken via TTS and drives model animations — not rendered as a card image.',
  usage: '/avatar <text>',
  permissions: ['user'],
  aliases: [],
})
@injectable()
export class AvatarCommandHandler implements CommandHandler {
  name = 'avatar';
  description =
    'Drive the Live2D avatar to say something. The LLM replies in the avatar\'s first-person voice; the reply is spoken via TTS and drives model animations — not rendered as a card image.';
  usage = '/avatar <text>';

  /** Max input length; avatar replies are short by design. */
  private readonly MAX_INPUT_CHARS = 500;

  private avatar: AvatarService | null = null;

  constructor(
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.CONFIG) private config: Config,
  ) {
    // Lazy-resolve AvatarService so the command stays usable even when the
    // avatar subsystem failed to initialize (we'll just skip speak()/drive
    // animations and still return the LLM reply as text).
    const container = getContainer();
    if (container.isRegistered(DITokens.AVATAR_SERVICE)) {
      this.avatar = container.resolve<AvatarService>(DITokens.AVATAR_SERVICE);
    }
  }

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

    let systemPrompt: string;
    try {
      systemPrompt = this.promptManager.render('avatar.speak-system', {});
    } catch (err) {
      logger.error('[AvatarCommandHandler] failed to render system prompt', err);
      return {
        success: false,
        error: 'Avatar prompt template missing (prompts/avatar/speak-system.txt).',
      };
    }

    // Choose provider: prefer the bot's configured default LLM so the avatar
    // voice style follows the same model the user picked.
    const aiConfig = this.config.getAIConfig();
    const providerName = aiConfig?.defaultProviders?.llm ?? 'deepseek';

    let replyText: string;
    try {
      const response = await this.llmService.generate(
        input,
        {
          maxTokens: 256,
          temperature: 0.8,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input },
          ],
        },
        providerName,
      );
      replyText = (response.text ?? '').trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[AvatarCommandHandler] LLM generation failed:', err);
      return {
        success: false,
        error: `Avatar LLM failed: ${msg}`,
      };
    }

    if (replyText.length === 0) {
      return {
        success: false,
        error: 'Avatar LLM returned empty reply.',
      };
    }

    // Parse Live2D tags → drive animation + speak; then strip tags for delivery.
    if (this.avatar?.isActive()) {
      try {
        const tags = parseLive2DTags(replyText);
        for (const tag of tags) {
          this.avatar.transition(this.tagToBotState(tag));
          this.avatar.enqueueTagAnimation(tag);
        }
      } catch (err) {
        logger.warn('[AvatarCommandHandler] tag parse / enqueue failed (non-fatal):', err);
      }
    }

    const spoken = stripLive2DTags(replyText).trim();
    if (this.avatar?.isActive() && spoken.length > 0) {
      try {
        this.avatar.speak(spoken);
      } catch (err) {
        logger.warn('[AvatarCommandHandler] speak() failed (non-fatal):', err);
      }
    }

    // Return as a plain text segment. Commands bypass the reply pipeline's
    // card-rendering stage entirely, so even multi-sentence replies are sent
    // as text exactly as the LLM produced them (sans tags).
    const messageBuilder = new MessageBuilder();
    messageBuilder.text(spoken.length > 0 ? spoken : replyText);

    return {
      success: true,
      segments: messageBuilder.build(),
      sentAsForward: false,
    };
  }

  /** Mirrors Live2DAvatarPlugin.tagToBotState — keep in sync if one changes. */
  private tagToBotState(tag: { emotion: string }): 'reacting' | 'thinking' | 'speaking' {
    switch (tag.emotion) {
      case 'happy':
      case 'excited':
      case 'surprised':
      case 'sad':
      case 'angry':
      case 'shy':
        return 'reacting';
      case 'thinking':
        return 'thinking';
      default:
        return 'speaking';
    }
  }
}
