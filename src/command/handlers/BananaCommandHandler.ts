import { AIService, Image2ImageOptions, Text2ImageOptions } from '@/ai';
import { extractImagesFromMessageAndReply, visionImageToString } from '@/ai/utils/imageUtils';
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { buildMessageFromResponse } from '@/message/MessageBuilderUtils';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';
import { createHookContextForCommand } from '../utils/HookContextBuilder';

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

  private messageAPI: MessageAPI;

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
  ) {
    this.messageAPI = new MessageAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Check if prompt is provided (required for both text2img and img2img)
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

      // Check if prompt is empty after parsing
      if (!prompt || prompt.trim().length === 0) {
        return {
          success: false,
          error: 'Please provide a prompt. Usage: /banana <prompt> [options]',
        };
      }

      // Create hook context for AIService
      const hookContext = createHookContextForCommand(context, prompt);

      // Extract images from current message and referenced reply message
      let images: Awaited<ReturnType<typeof extractImagesFromMessageAndReply>> = [];
      if (context.originalMessage) {
        try {
          images = await extractImagesFromMessageAndReply(
            context.originalMessage,
            this.messageAPI,
            this.databaseManager,
          );
          logger.debug(`[BananaCommand] Extracted ${images.length} image(s) from message`);
        } catch (error) {
          logger.warn(`[BananaCommand] Failed to extract images: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // Continue without images - will use text2img
        }
      } else {
        logger.debug(`[BananaCommand] No originalMessage in context, skipping image extraction`);
      }

      const silent = options.silent === true;

      // If images are found, use image-to-image transformation
      if (images.length > 0) {
        logger.info(`[BananaCommand] Using image-to-image transformation with ${images.length} image(s)`);

        // Use first image for transformation
        let inputImage: string;
        try {
          inputImage = visionImageToString(images[0]!);
        } catch (error) {
          logger.error(`[BananaCommand] Failed to convert image to string format: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return {
            success: false,
            error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }

        // Prepare image2image options
        const img2imgOptions: Image2ImageOptions = {
          aspectRatio: options.aspectRatio,
          imageSize: options.imageSize,
          model: options.model || 'gemini-2.5-flash-image',
        };

        // Generate image from image (no LLM preprocessing for img2img)
        const response = await this.aiService.generateImageFromImage(
          hookContext,
          inputImage,
          prompt,
          img2imgOptions,
          'laozhang',
        );
        logger.info(`[BananaCommand] Image generation from image completed`);

        // If no images and no text, return error
        if ((!response.images || response.images.length === 0) && !response.text) {
          return {
            success: false,
            error: 'No images generated and no error message received',
          };
        }

        // Build image response (unless silent mode)
        let imageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(response, '[BananaCommand]');
          imageSegments = messageBuilder.build();
        }

        return {
          success: true,
          segments: imageSegments,
        };
      } else {
        // No images found, use text-to-image generation
        logger.info(`[BananaCommand] Using text-to-image generation with prompt: ${prompt.substring(0, 50)}...`);

        // Generate image using Laozhang provider with Gemini 2.5 model
        const imageOptions: Text2ImageOptions = {
          ...options,
          prompt, // Must provide prompt in options
          model: options.model || 'gemini-2.5-flash-image', // Use Gemini 2.5 model for small banana
        };

        // Use LLM preprocessing based on llm parameter
        // If llm is true, use LLM preprocessing with template; if false or undefined, skip LLM preprocessing
        // Check if plugin has set a template name (for SFW filter)
        const pluginTemplateName = context.conversationContext.metadata?.get('text2imgTemplateName');
        const forceLLMProcess = context.conversationContext.metadata?.get('text2imgForceLLMProcess') === true;

        let skipLLMProcess = options.llm === false || options.llm === undefined;
        let templateName: string | undefined = options.llm === true ? 'text2img.generate_banana' : undefined;

        // If SFW filter is active, override template and force LLM processing
        if (forceLLMProcess && pluginTemplateName && typeof pluginTemplateName === 'string') {
          skipLLMProcess = false;
          templateName = pluginTemplateName;
          logger.info(`[BananaCommand] SFW filter active, forcing LLM preprocessing with template: ${templateName}`);
        }

        const response = await this.aiService.generateImg(
          hookContext,
          imageOptions,
          'laozhang',
          skipLLMProcess,
          templateName,
        );
        logger.info(`[BananaCommand] Image generation completed`);

        // If no images and no text, return error
        if ((!response.images || response.images.length === 0) && !response.text) {
          return {
            success: false,
            error: 'No images generated and no error message received',
          };
        }

        // Build image response (unless silent mode)
        let imageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(response, '[BananaCommand]');
          imageSegments = messageBuilder.build();
        }

        return {
          success: true,
          segments: imageSegments,
        };
      }
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
      silent: { property: 'silent', type: 'boolean' },
    },
  };

  private messageAPI: MessageAPI;

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
  ) {
    this.messageAPI = new MessageAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Check if prompt is provided (required for both text2img and img2img)
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /banana-pro <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions & Image2ImageOptions>(
        args,
        this.argsConfig,
      );

      // Check if prompt is empty after parsing
      if (!prompt || prompt.trim().length === 0) {
        return {
          success: false,
          error: 'Please provide a prompt. Usage: /banana-pro <prompt> [options]',
        };
      }

      // Create hook context for AIService
      const hookContext = createHookContextForCommand(context, prompt);

      // Extract images from current message and referenced reply message
      let images: Awaited<ReturnType<typeof extractImagesFromMessageAndReply>> = [];
      if (context.originalMessage) {
        try {
          images = await extractImagesFromMessageAndReply(
            context.originalMessage,
            this.messageAPI,
            this.databaseManager,
          );
          logger.debug(`[BananaProCommand] Extracted ${images.length} image(s) from message`);
        } catch (error) {
          logger.warn(`[BananaProCommand] Failed to extract images: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // Continue without images - will use text2img
        }
      } else {
        logger.debug(`[BananaProCommand] No originalMessage in context, skipping image extraction`);
      }

      const silent = options.silent === true;

      // If images are found, use image-to-image generation
      if (images.length > 0) {
        logger.info(`[BananaProCommand] Using image-to-image generation with ${images.length} image(s)`);

        // Use first image for generation
        let inputImage: string;
        try {
          inputImage = visionImageToString(images[0]!);
        } catch (error) {
          logger.error(`[BananaProCommand] Failed to convert image to string format: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return {
            success: false,
            error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }

        // Prepare image2image options
        const img2imgOptions: Image2ImageOptions = {
          aspectRatio: options.aspectRatio,
          imageSize: options.imageSize,
          model: options.model || 'gemini-3-pro-image-preview', // Use Gemini 3 Pro model for big banana
        };

        // Generate image from image (no LLM preprocessing for img2img)
        const response = await this.aiService.generateImageFromImage(
          hookContext,
          inputImage,
          prompt,
          img2imgOptions,
          'laozhang',
        );
        logger.info(`[BananaProCommand] Image generation from image completed`);

        // If no images and no text, return error
        if ((!response.images || response.images.length === 0) && !response.text) {
          return {
            success: false,
            error: 'No images generated and no error message received',
          };
        }

        // Build image response (unless silent mode)
        let imageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(response, '[BananaProCommand]');
          imageSegments = messageBuilder.build();
        }

        return {
          success: true,
          segments: imageSegments,
        };
      } else {
        // No images found, use text-to-image generation
        logger.info(`[BananaProCommand] Using text-to-image generation with prompt: ${prompt.substring(0, 50)}...`);

        // Generate image using Laozhang provider with Gemini 3 Pro model
        // Use LLM preprocessing with generate_banana template for better prompt optimization
        const imageOptions: Text2ImageOptions = {
          ...options,
          prompt, // Must provide prompt in options
          model: options.model || 'gemini-3-pro-image-preview', // Use Gemini 3 Pro model for big banana
        };

        // Check if plugin has set a template name (for SFW filter)
        const pluginTemplateName = context.conversationContext.metadata?.get('text2imgTemplateName');
        const forceLLMProcess = context.conversationContext.metadata?.get('text2imgForceLLMProcess') === true;

        let skipLLMProcess = false; // Default: enable LLM preprocessing for banana-pro
        let templateName: string = 'text2img.generate_banana'; // Default template

        // If SFW filter is active, override template
        if (forceLLMProcess && pluginTemplateName && typeof pluginTemplateName === 'string') {
          templateName = pluginTemplateName;
          logger.info(`[BananaProCommand] SFW filter active, using template: ${templateName}`);
        }

        const response = await this.aiService.generateImg(
          hookContext,
          imageOptions,
          'laozhang',
          skipLLMProcess,
          templateName,
        );
        logger.info(`[BananaProCommand] Image generation completed`);

        // If no images and no text, return error
        if ((!response.images || response.images.length === 0) && !response.text) {
          return {
            success: false,
            error: 'No images generated and no error message received',
          };
        }

        // Build image response (unless silent mode)
        let imageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(response, '[BananaProCommand]');
          imageSegments = messageBuilder.build();
        }

        return {
          success: true,
          segments: imageSegments,
        };
      }
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
