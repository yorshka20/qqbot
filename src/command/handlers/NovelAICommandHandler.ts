import { AIService, Text2ImageOptions } from '@/ai';
import { APIClient } from '@/api/APIClient';
import { DITokens } from '@/core/DITokens';
import { NormalizedMessageEvent } from '@/events/types';
import { HookContext } from '@/hooks';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * NovelAI command - generates image from text prompt using NovelAI provider
 */
@Command({
  name: 'nai',
  description: 'Generate image from text prompt using NovelAI',
  usage:
    '/nai <prompt> [--width <width>] [--height <height>] [--steps <steps>] [--seed <seed>] [--guidance <scale>] [--negative <prompt>]',
  permissions: ['user'], // All users can generate images
})
@injectable()
export class NovelAICommand implements CommandHandler {
  name = 'nai';
  description = 'Generate image from text prompt using NovelAI';
  usage = '/nai <prompt> [options]';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /nai <prompt> [options]',
      };
    }

    try {
      // Parse arguments
      const { prompt, options } = this.parseArguments(args);

      logger.info(`[NovelAICommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

      // Create hook context for AIService
      const hookContext: HookContext = {
        message: {
          id: `cmd_${Date.now()}`,
          type: 'message',
          timestamp: Date.now(),
          protocol: 'command',
          userId: context.userId,
          groupId: context.groupId,
          messageId: undefined,
          messageType: context.messageType,
          message: prompt,
          segments: [],
        } as NormalizedMessageEvent,
        metadata: new Map([
          ['sessionId', context.groupId ? `group_${context.groupId}` : `user_${context.userId}`],
          ['sessionType', context.messageType],
        ]),
      };

      // Generate image using NovelAI provider (force provider name)
      // Skip LLM preprocessing for /nai command - use user input directly as prompt
      const response = await this.aiService.generateImg(hookContext, options, 'novelai', true);
      logger.info(`[NovelAICommand] Generated image with response: ${JSON.stringify(response)}`);
      if (!response.images || response.images.length === 0) {
        return {
          success: false,
          error: 'No images generated',
        };
      }

      // Build message with images
      const messageBuilder = new MessageBuilder();

      // Add text message if multiple images
      if (response.images.length > 1) {
        messageBuilder.text(`Generated ${response.images.length} images:\n`);
      }

      // Add each image
      for (const image of response.images) {
        if (image.base64) {
          // Use base64 data directly for Milky protocol
          // Milky protocol supports base64 data in the 'data' field
          messageBuilder.image({ data: image.base64 });
        } else if (image.url) {
          messageBuilder.image({ url: image.url });
        } else if (image.file) {
          messageBuilder.image({ file: image.file });
        } else {
          logger.warn(`[NovelAICommand] Image has no base64, url, or file field: ${JSON.stringify(image)}`);
        }
      }

      const messageSegments = messageBuilder.build();

      if (context.messageType === 'private') {
        await this.apiClient.call(
          'send_private_msg',
          {
            user_id: context.userId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for image generation
        );
      } else if (context.groupId) {
        await this.apiClient.call(
          'send_group_msg',
          {
            group_id: context.groupId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for image generation
        );
      }

      return {
        success: true,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[NovelAICommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }

  /**
   * Parse command arguments
   * Supports: /nai prompt --width 512 --height 512 --steps 50 --seed 123 --guidance 7.5 --negative "bad prompt"
   */
  private parseArguments(args: string[]): {
    prompt: string;
    options: Text2ImageOptions;
  } {
    const options: Text2ImageOptions = {};
    const promptParts: string[] = [];
    let i = 0;

    // Collect prompt text (until we hit an option flag)
    while (i < args.length && !args[i].startsWith('--')) {
      promptParts.push(args[i]);
      i++;
    }

    const prompt = promptParts.join(' ');

    // Parse options
    while (i < args.length) {
      const arg = args[i];
      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const nextArg = args[i + 1];

        switch (optionName) {
          case 'width':
            if (nextArg) {
              options.width = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'height':
            if (nextArg) {
              options.height = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'steps':
            if (nextArg) {
              options.steps = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'seed':
            if (nextArg) {
              options.seed = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'guidance':
            if (nextArg) {
              options.guidance_scale = parseFloat(nextArg);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'negative':
            if (nextArg) {
              options.negative_prompt = nextArg;
              i += 2;
            } else {
              i++;
            }
            break;
          case 'num':
          case 'num_images':
            if (nextArg) {
              options.numImages = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          default:
            // Unknown option, skip
            i++;
            break;
        }
      } else {
        i++;
      }
    }

    return { prompt, options };
  }
}
