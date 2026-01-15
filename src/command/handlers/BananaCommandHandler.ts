import { AIService, Text2ImageOptions } from '@/ai';
import { APIClient } from '@/api/APIClient';
import { DITokens } from '@/core/DITokens';
import { HookContext } from '@/hooks';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Banana command - generates image from text prompt using Gemini provider
 * Directly uses user input as prompt without LLM preprocessing
 */
@Command({
  name: 'banana',
  description: 'Generate image from text prompt using Gemini',
  usage: '/banana <prompt> [--width=<width>] [--height=<height>]',
  permissions: ['user'], // All users can generate images
})
@injectable()
export class BananaCommand implements CommandHandler {
  name = 'banana';
  description = 'Generate image from text prompt using Gemini';
  usage = '/banana <prompt> [options]';

  // Command parameter configuration
  private readonly argsConfig: ParserConfig = {
    options: {
      width: { property: 'width', type: 'number' },
      height: { property: 'height', type: 'number' },
      steps: { property: 'steps', type: 'number' },
      seed: { property: 'seed', type: 'number' },
      guidance: { property: 'guidance_scale', type: 'float' },
      negative: { property: 'negative_prompt', type: 'string' },
      num: { property: 'numImages', type: 'number', aliases: ['num_images'] },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /banana <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions>(args, this.argsConfig);

      logger.info(`[BananaCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

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
        },
        metadata: new Map([
          ['sessionId', context.groupId ? `group_${context.groupId}` : `user_${context.userId}`],
          ['sessionType', context.messageType],
        ]),
      };

      // Generate image using Gemini provider (force provider name)
      // Skip LLM preprocessing for /banana command - use user input directly as prompt
      const response = await this.aiService.generateImg(hookContext, options, 'gemini', true);
      logger.info(`[BananaCommand] Generated image with response: ${JSON.stringify(response)}`);
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
      // File paths are already converted to URLs by ImageGenerationService
      for (const image of response.images) {
        if (image.url) {
          // Prefer URL over base64 for better performance
          messageBuilder.image({ url: image.url });
        } else if (image.base64) {
          // Fallback to base64 if URL is not available
          // Milky protocol supports base64 data in the 'data' field
          messageBuilder.image({ data: image.base64 });
        } else {
          logger.warn(`[BananaCommand] Image has no url or base64 field: ${JSON.stringify(image)}`);
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
      logger.error('[BananaCommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }
}
