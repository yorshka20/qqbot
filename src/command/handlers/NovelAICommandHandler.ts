import { AIService, Text2ImageOptions } from '@/ai';
import { APIClient } from '@/api/APIClient';
import { DITokens } from '@/core/DITokens';
import { NormalizedMessageEvent } from '@/events/types';
import { HookContext } from '@/hooks';
import { MetadataMap } from '@/hooks/metadata';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * NovelAI command - generates image from text prompt using NovelAI provider
 */
@Command({
  name: 'nai',
  description: 'Generate image from text prompt using NovelAI',
  usage:
    '/nai <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>]',
  permissions: ['user'], // All users can generate images
})
@injectable()
export class NovelAICommand implements CommandHandler {
  name = 'nai';
  description = 'Generate image from text prompt using NovelAI';
  usage = '/nai <prompt> [options]';

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
        error: 'Please provide a prompt. Usage: /nai <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions>(args, this.argsConfig);

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
        metadata: MetadataMap.fromEntries([
          ['sessionId', context.groupId ? `group_${context.groupId}` : `user_${context.userId}`],
          ['sessionType', context.messageType],
        ]),
      };

      // Generate image using NovelAI provider (force provider name)
      // Skip LLM preprocessing for /nai command - use user input directly as prompt
      const response = await this.aiService.generateImg(hookContext, options, 'novelai', true);
      logger.info(`[NovelAICommand] Generated image with response: ${JSON.stringify(response)}`);

      // If no images and no text, return error
      if ((!response.images || response.images.length === 0) && !response.text) {
        return {
          success: false,
          error: 'No images generated and no error message received',
        };
      }

      // Build message with images and text
      const messageBuilder = new MessageBuilder();

      // Add text message from provider if available (may contain error message)
      if (response.text) {
        messageBuilder.text(response.text);
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
          logger.warn(`[NovelAICommand] Image has no url or base64 field: ${JSON.stringify(image)}`);
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
}
