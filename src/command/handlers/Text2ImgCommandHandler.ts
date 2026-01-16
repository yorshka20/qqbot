import { AIService, Text2ImageOptions } from '@/ai';
import { AIManager } from '@/ai/AIManager';
import { APIClient } from '@/api/APIClient';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Text2Image command - generates image from text prompt
 */
@Command({
  name: 't2i',
  description: 'Generate image from text prompt',
  usage:
    '/t2i <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>]',
  permissions: ['user'], // All users can generate images
  aliases: ['text2img'],
})
@injectable()
export class Text2ImageCommand implements CommandHandler {
  name = 't2i';
  description = 'Generate image from text prompt';
  usage = '/t2i <prompt> [options]';

  private defaultProviderName = 'local-text2img';

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
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /t2i <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions>(args, this.argsConfig);

      logger.info(`[Text2ImageCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

      // Create hook context for AIService
      const hookContext = HookContextBuilder.create()
        .withSyntheticMessage({
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
        })
        .withMetadata('sessionId', context.groupId ? `group_${context.groupId}` : `user_${context.userId}`)
        .withMetadata('sessionType', context.messageType === 'private' ? 'user' : context.messageType)
        .build();

      // Determine which provider to use: try local-text2img first, fallback to novelai if unavailable
      let providerName: string = this.defaultProviderName;
      const localProvider = this.aiManager.getProviderForCapability('text2img', this.defaultProviderName);
      if (!localProvider || !localProvider.isAvailable()) {
        logger.info(
          `[Text2ImageCommand] ${this.defaultProviderName} provider is not available, falling back to novelai`,
        );
        providerName = 'novelai';
      } else {
        logger.debug(`[Text2ImageCommand] Using ${this.defaultProviderName} provider`);
      }

      // Generate image with selected provider, with fallback to novelai if local-text2img fails
      let response;

      try {
        response = await this.aiService.generateImg(hookContext, options, providerName, false, 'text2img.generate');
        logger.info(`[Text2ImageCommand] Generated image with response: ${JSON.stringify(response)}`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        // If local-text2img fails, directly fallback to novelai
        if (providerName === this.defaultProviderName) {
          logger.warn(
            `[Text2ImageCommand] ${this.defaultProviderName} provider failed, falling back to novelai: ${err.message}`,
          );
          response = await this.aiService.generateImg(
            hookContext,
            options,
            'novelai',
            false, // Keep LLM preprocessing for fallback
            'text2img.generate_nai', // Use NovelAI-specific template
          );
          logger.info(`[Text2ImageCommand] Generated image with fallback provider: ${JSON.stringify(response)}`);
        } else {
          // Re-throw other errors
          throw error;
        }
      }

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
      // Priority: URL first, then base64 (filepath not supported)
      for (const image of response.images) {
        if (image.url) {
          // Prefer URL over base64 for better performance
          messageBuilder.image({ url: image.url });
        } else if (image.base64) {
          // Fallback to base64 if URL is not available
          // Milky protocol supports base64 data in the 'data' field
          messageBuilder.image({ data: image.base64 });
        } else {
          logger.warn(`[Text2ImageCommand] Image has no url or base64 field: ${JSON.stringify(image)}`);
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
      logger.error('[Text2ImageCommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }
}
