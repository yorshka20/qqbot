import { AIService, Text2ImageOptions } from '@/ai';
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
 * Banana command - generates image from text prompt using Laozhang AI provider (Gemini 2.5 model)
 * Directly uses user input as prompt without LLM preprocessing
 */
@Command({
  name: 'banana',
  description: 'Generate image from text prompt using Laozhang AI (Gemini 2.5)',
  usage: '/banana <prompt> [--aspectRatio=<ratio>] [--imageSize=<size>]',
  aliases: ['小香蕉'],
  permissions: ['user'], // All users can generate images
})
@injectable()
export class BananaCommand implements CommandHandler {
  name = 'banana';
  description = 'Generate image from text prompt using Laozhang AI (Gemini 2.5)';
  usage = '/banana <prompt> [options]';

  // Command parameter configuration
  private readonly argsConfig: ParserConfig = {
    options: {
      aspectRatio: { property: 'aspectRatio', type: 'string' },
      imageSize: { property: 'imageSize', type: 'string' },
      model: { property: 'model', type: 'string' },
      llm: { property: 'llm', type: 'boolean' },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) { }

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
      const { llm } = options as { llm: boolean };

      logger.info(`[BananaCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

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

      // Generate image using Laozhang provider with Gemini 2.5 model
      const imageOptions = {
        ...options,
        model: 'gemini-2.5-flash-image', // Use Gemini 2.5 model for small banana
      };

      // Use LLM preprocessing based on llm parameter
      // If llm is true, use LLM preprocessing with template; if false or undefined, skip LLM preprocessing
      const skipLLMProcess = llm === false || llm === undefined;
      const templateName = llm === true ? 'text2img.generate_banana' : undefined;
      const response = await this.aiService.generateImg(hookContext, imageOptions, 'laozhang', skipLLMProcess, templateName);
      logger.info(`[BananaCommand] respond`);

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

/**
 * Banana Pro command - generates image from text prompt using Laozhang AI provider (Gemini 3 Pro model)
 * Directly uses user input as prompt without LLM preprocessing
 */
@Command({
  name: 'banana-pro',
  description: 'Generate image from text prompt using Laozhang AI (Gemini 3 Pro)',
  usage: '/banana-pro <prompt> [--aspectRatio=<ratio>] [--imageSize=<size>]',
  aliases: ['大香蕉'],
  permissions: ['user'], // All users can generate images
})
@injectable()
export class BananaProCommand implements CommandHandler {
  name = 'banana-pro';
  description = 'Generate image from text prompt using Laozhang AI (Gemini 3 Pro)';
  usage = '/banana-pro <prompt> [options]';

  // Command parameter configuration
  private readonly argsConfig: ParserConfig = {
    options: {
      aspectRatio: { property: 'aspectRatio', type: 'string' },
      imageSize: { property: 'imageSize', type: 'string' },
      model: { property: 'model', type: 'string' },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) { }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /banana-pro <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions>(args, this.argsConfig);

      logger.info(`[BananaProCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

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

      // Generate image using Laozhang provider with Gemini 3 Pro model
      // Use LLM preprocessing with generate_banana template for better prompt optimization
      const imageOptions = {
        ...options,
        model: 'gemini-3-pro-image-preview', // Use Gemini 3 Pro model for big banana
      };
      const response = await this.aiService.generateImg(
        hookContext,
        imageOptions,
        'laozhang',
        false, // Enable LLM preprocessing
        'text2img.generate_banana', // Use banana-specific template
      );
      logger.info(`[BananaProCommand] respond`);

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
          logger.warn(`[BananaProCommand] Image has no url or base64 field: ${JSON.stringify(image)}`);
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
      logger.error('[BananaProCommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }
}
