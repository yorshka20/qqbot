import { AIService, ImageGenerationResponse, Text2ImageOptions } from '@/ai';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';
import { generateSeed } from '../utils/CommandImageUtils';
import { createHookContextForCommand } from '../utils/HookContextBuilder';
import { buildMessageFromResponse } from '@/message/MessageBuilderUtils';

/**
 * NovelAI command - generates image from text prompt using NovelAI provider
 */
@Command({
  name: 'nai',
  description: 'Generate image from text prompt using NovelAI',
  usage:
    '/nai <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>] [--num=<number>]',
  permissions: ['user'], // All users can generate images
})
@injectable()
export class NovelAICommand implements CommandHandler {
  name = 'nai';
  description = 'Generate image from text prompt using NovelAI';
  usage = '/nai <prompt> [options] [--num=<number>]';

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
      silent: { property: 'silent', type: 'boolean' },
    },
  };

  constructor(@inject(DITokens.AI_SERVICE) private aiService: AIService) {}

  /**
   * Generate a single image
   */
  private async generateImage(
    hookContext: HookContext,
    options: Text2ImageOptions,
    index?: number,
    total?: number,
  ): Promise<ImageGenerationResponse> {
    const logPrefix =
      total !== undefined && index !== undefined
        ? `[NovelAICommand] Generating image ${index + 1}/${total}`
        : '[NovelAICommand] Generating image';

    logger.info(`${logPrefix} with options: ${JSON.stringify(options)}`);

    // Generate image using NovelAI provider (force provider name)
    // Skip LLM preprocessing for /nai command - use user input directly as prompt
    const response = await this.aiService.generateImg(hookContext, options, 'novelai', true);

    logger.info(`${logPrefix} completed with response: ${JSON.stringify(response)}`);

    return response;
  }

  /**
   * Build image response as message segments
   */
  private buildImageSegments(
    response: ImageGenerationResponse,
    silent?: boolean,
  ): MessageSegment[] | undefined {
    // If no images and no text, return undefined
    if ((!response.images || response.images.length === 0) && !response.text) {
      logger.warn('[NovelAICommand] No images generated and no error message received');
      return undefined;
    }

    // Build message segments (unless silent mode)
    if (!silent) {
      const messageBuilder = buildMessageFromResponse(response, '[NovelAICommand]');
      return messageBuilder.build();
    }
    return undefined;
  }

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
      const hookContext = createHookContextForCommand(context, prompt);

      // Check if num parameter is provided for multiple image generation
      const numImages = options?.numImages || 1;
      const baseSeed = options?.seed;
      const silent = options?.silent === true;

      // Prepare base options without numImages to avoid batch generation
      const baseOptions: Text2ImageOptions = {
        ...options,
        prompt,
        numImages: undefined, // Remove numImages to avoid batch generation
      };

      // If num > 1, generate images sequentially with different seeds
      // Note: For batch generation, we only return the first image segments
      // Subsequent images would need to be sent separately or handled differently
      if (numImages > 1) {
        logger.info(`[NovelAICommand] Generating ${numImages} images sequentially with different seeds`);

        // Generate first image to return
        const firstSeed = generateSeed(baseSeed, 0);
        const firstOptions: Text2ImageOptions = {
          ...baseOptions,
          seed: firstSeed,
        };

        const firstResponse = await this.generateImage(hookContext, firstOptions, 0, numImages);
        const firstImageSegments = this.buildImageSegments(firstResponse, silent);

        // Generate remaining images (but don't send them - they would need separate handling)
        // TODO: Consider implementing a mechanism for sending multiple messages through pipeline
        for (let i = 1; i < numImages; i++) {
          const currentSeed = generateSeed(baseSeed, i);
          const currentOptions: Text2ImageOptions = {
            ...baseOptions,
            seed: currentSeed,
          };
          // Generate but don't send (would need separate pipeline call)
          await this.generateImage(hookContext, currentOptions, i, numImages);
        }

        return {
          success: true,
          segments: firstImageSegments,
        };
      }

      // Single image generation (original behavior)
      const response = await this.generateImage(hookContext, baseOptions);
      const imageSegments = this.buildImageSegments(response, silent);
      if (!imageSegments) {
        return {
          success: false,
          error: 'No images generated and no error message received',
        };
      }

      return {
        success: true,
        segments: imageSegments,
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
