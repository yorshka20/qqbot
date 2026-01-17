import { AIService, ImageGenerationResponse, Text2ImageOptions } from '@/ai';
import { AIManager } from '@/ai/AIManager';
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
 * Text2Image command - generates image from text prompt
 */
@Command({
  name: 't2i',
  description: 'Generate image from text prompt',
  usage:
    '/t2i <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>] [--num=<number>] [--silent]',
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
      silent: { property: 'silent', type: 'boolean' },
      template: { property: 'template', type: 'string' },
    },
  };

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
  ) {}

  /**
   * Generate image with provider fallback
   * If primary provider fails and it's the default provider, fallback to novelai
   */
  private async generateWithProvider(
    hookContext: HookContext,
    opts: Text2ImageOptions,
    providerName: string,
    skipLLMProcess: boolean,
    templateName: string | undefined,
  ): Promise<ImageGenerationResponse> {
    try {
      return await this.aiService.generateImg(hookContext, opts, providerName, skipLLMProcess, templateName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      // If local-text2img fails, directly fallback to novelai
      if (providerName === this.defaultProviderName) {
        logger.warn(
          `[Text2ImageCommand] ${this.defaultProviderName} provider failed, falling back to novelai: ${err.message}`,
        );
        return await this.aiService.generateImg(
          hookContext,
          opts,
          'novelai',
          skipLLMProcess, // Use same skipLLMProcess flag for fallback
          templateName || 'text2img.generate_nai', // Use NovelAI-specific template for fallback
        );
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  }

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
      const hookContext = createHookContextForCommand(context, prompt);

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

      // Check if num parameter is provided for multiple image generation
      const numImages = options?.numImages || 1;
      const baseSeed = options?.seed;
      const silent = options?.silent === true;
      const templateName = options?.template || 'text2img.generate';

      // Prepare base options without numImages to avoid batch generation
      const baseOptions: Text2ImageOptions = {
        ...options,
        prompt, // Must provide prompt in options
        numImages: undefined, // Remove numImages to avoid batch generation
      };

      // If num > 1, first call LLM preprocessing to get processed prompt, then loop with skipLLMProcess=true
      if (numImages > 1) {
        logger.info(
          `[Text2ImageCommand] Generating ${numImages} images - first call LLM preprocessing, then loop generateImage`,
        );

        // First call: LLM preprocessing to get processed prompt
        const firstResponse = await this.generateWithProvider(hookContext, baseOptions, providerName, false, templateName);

        // Get processed prompt from first response
        if (!firstResponse.prompt) {
          logger.warn('[Text2ImageCommand] First response does not contain processed prompt, falling back to user input');
        }

        // used in batch generation
        const processedPrompt = firstResponse.prompt || prompt;

        // If first response failed, return error
        if ((!firstResponse.images || firstResponse.images.length === 0) && !firstResponse.text) {
          return {
            success: false,
            error: 'No images generated and no error message received',
          };
        }

        // Build first image message (unless silent mode)
        let firstImageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(firstResponse, '[Text2ImageCommand]');
          firstImageSegments = messageBuilder.build();
        }

        // Determine template name for remaining images (same as first call or novelai template if fallback happened)
        const remainingTemplateName = providerName === 'novelai' ? 'text2img.generate_nai' : undefined;

        // Generate remaining images with processed prompt (skip LLM processing)
        for (let i = 1; i < numImages; i++) {
          logger.info(`[Text2ImageCommand] Generating image ${i + 1}/${numImages} with processed prompt`);

          // Update seed for each image
          const currentSeed = generateSeed(baseSeed, i);
          const processedOptions = {
            ...baseOptions,
            prompt: processedPrompt,
            seed: currentSeed,
          };

          const response = await this.generateWithProvider(hookContext, processedOptions, providerName, true, remainingTemplateName);
          // Build image message (unless silent mode)
          // Note: For batch generation, we only return the first image segments
          // Subsequent images would need to be sent separately or handled differently
          if (!silent && !firstImageSegments) {
            const messageBuilder = buildMessageFromResponse(response, '[Text2ImageCommand]');
            firstImageSegments = messageBuilder.build();
          }
        }

        return {
          success: true,
          segments: firstImageSegments,
        };
      }

      // Single image generation (original behavior)
      // Generate image with selected provider, with fallback to novelai if local-text2img fails
      const response = await this.generateWithProvider(hookContext, baseOptions, providerName, false, 'text2img.generate');
      logger.info(`[Text2ImageCommand] Generated image with response: ${JSON.stringify(response)}`);

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
        const messageBuilder = buildMessageFromResponse(response, '[Text2ImageCommand]');
        imageSegments = messageBuilder.build();
      }

      return {
        success: true,
        segments: imageSegments,
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
