import { inject, injectable } from 'tsyringe';
import type { AIService, Image2ImageOptions, Text2ImageOptions } from '@/ai';
import { extractImagesFromMessageAndReply, visionImageToString } from '@/ai/utils/imageUtils';
import type { APIClient } from '@/api/APIClient';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { buildMessageFromResponse } from '@/message/MessageBuilderUtils';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';
import { createHookContextForCommand } from '../utils/HookContextBuilder';

/**
 * /gpt2 — text2img + img2img via OpenAI gpt-image-2.
 *
 * Single mode: if the message (or its referenced reply) carries an image, we
 * route to `/v1/images/edits`; otherwise to `/v1/images/generations`. Mirrors
 * the BananaCommand auto-switch so users don't need a second command.
 *
 * Routes through `AIService` with provider hardcoded to `'openai'`; OpenAIProvider
 * must have `image.enabled: true` configured for `text2img` + `img2img` to be
 * registered as capabilities.
 */
@Command({
  name: 'gpt2',
  description: 'Generate or edit image with OpenAI gpt-image-2',
  usage: '/gpt2 <prompt> [--size=<size>] [--quality=<low|medium|high|auto>] [--silent]',
  permissions: ['user'],
})
@injectable()
export class Gpt2Command implements CommandHandler {
  name = 'gpt2';
  description = 'Generate or edit image with OpenAI gpt-image-2';
  usage = '/gpt2 <prompt> [options]';

  private readonly argsConfig: ParserConfig = {
    options: {
      size: { property: 'imageSize', type: 'string' },
      imageSize: { property: 'imageSize', type: 'string' },
      quality: { property: 'quality', type: 'string' },
      model: { property: 'model', type: 'string' },
      silent: { property: 'silent', type: 'boolean' },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return { success: false, error: 'Please provide a prompt. Usage: /gpt2 <prompt> [options]' };
    }

    try {
      const { text: prompt, options } = CommandArgsParser.parse<
        Text2ImageOptions & Image2ImageOptions & { silent?: boolean }
      >(args, this.argsConfig);

      if (!prompt || prompt.trim().length === 0) {
        return { success: false, error: 'Please provide a prompt. Usage: /gpt2 <prompt> [options]' };
      }

      const hookContext = createHookContextForCommand(context, prompt);

      let images: Awaited<ReturnType<typeof extractImagesFromMessageAndReply>> = [];
      if (context.originalMessage) {
        try {
          images = await extractImagesFromMessageAndReply(
            context.originalMessage,
            this.messageAPI,
            this.databaseManager,
          );
          logger.debug(`[Gpt2Command] Extracted ${images.length} image(s) from message`);
        } catch (error) {
          logger.warn(
            `[Gpt2Command] Failed to extract images: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      const silent = options.silent === true;

      if (images.length > 0) {
        logger.info(`[Gpt2Command] img2img with ${images.length} image(s)`);

        let inputImage: string;
        try {
          inputImage = visionImageToString(images[0]!);
        } catch (error) {
          return {
            success: false,
            error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }

        const img2imgOptions: Image2ImageOptions = {
          imageSize: options.imageSize,
          model: options.model,
        };

        const response = await this.aiService.generateImageFromImage(
          hookContext,
          inputImage,
          prompt,
          img2imgOptions,
          'openai',
        );

        if ((!response.images || response.images.length === 0) && !response.text) {
          return { success: false, error: 'No images generated and no error message received' };
        }

        let imageSegments: MessageSegment[] | undefined;
        if (!silent) {
          imageSegments = buildMessageFromResponse(response, '[Gpt2Command]').build();
        }

        return { success: true, segments: imageSegments };
      }

      logger.info(`[Gpt2Command] text2img | prompt=${prompt.substring(0, 50)}...`);

      const imageOptions: Text2ImageOptions = {
        ...options,
        prompt,
        model: options.model,
      };

      // skipLLMProcess=true — like /banana, treat user input as the literal prompt.
      const response = await this.aiService.generateImg(hookContext, imageOptions, 'openai', true);

      if ((!response.images || response.images.length === 0) && !response.text) {
        return { success: false, error: 'No images generated and no error message received' };
      }

      let imageSegments: MessageSegment[] | undefined;
      if (!silent) {
        imageSegments = buildMessageFromResponse(response, '[Gpt2Command]').build();
      }

      return { success: true, segments: imageSegments };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[Gpt2Command] Failed to generate image:', err);
      return { success: false, error: `Failed to generate image: ${err.message}` };
    }
  }
}
