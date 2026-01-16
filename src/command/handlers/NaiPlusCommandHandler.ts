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
 * NaiPlus command - generates image from text prompt using NovelAI provider with LLM preprocessing
 * Similar to t2i but uses NovelAI-specific prompt template and forces NovelAI provider
 */
@Command({
  name: 'nai-plus',
  description: 'Generate image from text prompt using NovelAI with LLM preprocessing',
  usage:
    '/nai-plus <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>]',
  permissions: ['user'], // All users can generate images
})
@injectable()
export class NaiPlusCommand implements CommandHandler {
  name = 'nai-plus';
  description = 'Generate image from text prompt using NovelAI with LLM preprocessing';
  usage = '/nai-plus <prompt> [options]';

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
        error: 'Please provide a prompt. Usage: /nai-plus <prompt> [options]',
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text: prompt, options } = CommandArgsParser.parse<Text2ImageOptions>(args, this.argsConfig);

      logger.info(`[NaiPlusCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

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

      // Generate image using NovelAI provider with LLM preprocessing
      // Do not skip LLM preprocessing (skipLLMProcess = false)
      const response = await this.aiService.generateImg(
        hookContext,
        options,
        'novelai', // Force NovelAI provider
        false, // Do not skip LLM preprocessing
        'text2img.generate_nai', // Use NovelAI-specific template
      );
      logger.info(`[NaiPlusCommand] Generated image with response: ${JSON.stringify(response)}`);

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
          logger.warn(`[NaiPlusCommand] Image has no url or base64 field: ${JSON.stringify(image)}`);
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
      logger.error('[NaiPlusCommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }
}
