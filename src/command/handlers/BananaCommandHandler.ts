import { AIService, Text2ImageOptions } from '@/ai';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';
import { MessageSender } from '../utils/MessageSender';

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
      silent: { property: 'silent', type: 'boolean' },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(MessageSender) private messageSender: MessageSender,
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
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions & { llm?: boolean }>(
        args,
        this.argsConfig,
      );

      logger.info(`[BananaCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

      // Create hook context for AIService
      // Get protocol from context metadata (should be set by CommandContextBuilder)
      const protocol = context.metadata.protocol;
      const hookContext = HookContextBuilder.create()
        .withSyntheticMessage({
          id: `cmd_${Date.now()}`,
          type: 'message',
          timestamp: Date.now(),
          protocol,
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
      const imageOptions: Text2ImageOptions = {
        ...options,
        prompt, // Must provide prompt in options
        model: 'gemini-2.5-flash-image', // Use Gemini 2.5 model for small banana
      };

      // Use LLM preprocessing based on llm parameter
      // If llm is true, use LLM preprocessing with template; if false or undefined, skip LLM preprocessing
      const skipLLMProcess = options.llm === false || options.llm === undefined;
      const templateName = options.llm === true ? 'text2img.generate_banana' : undefined;
      const silent = options.silent === true;
      const response = await this.aiService.generateImg(
        hookContext,
        imageOptions,
        'laozhang',
        skipLLMProcess,
        templateName,
      );
      logger.info(`[BananaCommand] respond`);

      // If no images and no text, return error
      if ((!response.images || response.images.length === 0) && !response.text) {
        return {
          success: false,
          error: 'No images generated and no error message received',
        };
      }

      // Send image response (unless silent mode)
      if (!silent) {
        const messageBuilder = this.messageSender.buildMessage(response, '[BananaCommand]');
        await this.messageSender.send(messageBuilder.build(), context);
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
  usage: '/banana-pro <prompt> [--aspectRatio=<ratio>] [--imageSize=<size>] [--silent]',
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
    @inject(MessageSender) private messageSender: MessageSender,
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
      // Get protocol from context metadata (should be set by CommandContextBuilder)
      const protocol = context.metadata?.protocol || 'milky';
      const hookContext = HookContextBuilder.create()
        .withSyntheticMessage({
          id: `cmd_${Date.now()}`,
          type: 'message',
          timestamp: Date.now(),
          protocol,
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
      const imageOptions: Text2ImageOptions = {
        ...options,
        prompt, // Must provide prompt in options
        model: 'gemini-3-pro-image-preview', // Use Gemini 3 Pro model for big banana
      };
      const silent = options.silent === true;
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

      // Send image response (unless silent mode)
      if (!silent) {
        const messageBuilder = this.messageSender.buildMessage(response, '[BananaProCommand]');
        await this.messageSender.send(messageBuilder.build(), context);
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
