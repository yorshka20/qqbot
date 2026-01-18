import { AIService, Text2ImageOptions } from '@/ai';
import { DITokens } from '@/core/DITokens';
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
 * NaiPlus command - generates image from text prompt using NovelAI provider with LLM preprocessing
 * Similar to t2i but uses NovelAI-specific prompt template and forces NovelAI provider
 */
@Command({
  name: 'nai-plus',
  description: 'Generate image from text prompt using NovelAI with LLM preprocessing',
  usage:
    '/nai-plus <prompt> [--width=<width>] [--height=<height>] [--steps=<steps>] [--seed=<seed>] [--guidance=<scale>] [--negative=<prompt>] [--num=<number>]',
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
      silent: { property: 'silent', type: 'boolean' },
      template: { property: 'template', type: 'string' },
    },
  };

  constructor(@inject(DITokens.AI_SERVICE) private aiService: AIService) {}

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
      const hookContext = createHookContextForCommand(context, prompt);

      // Check if num parameter is provided for multiple image generation
      const numImages = options?.numImages || 1;
      const baseSeed = options?.seed;
      const silent = options?.silent === true;
      let templateName: string = options?.template || 'text2img.generate_nai';
      
      // Check if plugin has set a template name in metadata (from conversation context)
      const pluginTemplateName = context.conversationContext.metadata?.get('text2imgTemplateName');
      if (pluginTemplateName && typeof pluginTemplateName === 'string') {
        templateName = pluginTemplateName;
        logger.info(`[NaiPlusCommand] Using plugin-specified template: ${templateName}`);
      }

      // Prepare base options without numImages to avoid batch generation
      const baseOptions: Text2ImageOptions = {
        ...options,
        prompt, // Must provide prompt in options
        numImages: undefined, // Remove numImages to avoid batch generation
      };

      // If num > 1, first call LLM preprocessing to get processed prompt, then loop with skipLLMProcess=true
      if (numImages > 1) {
        logger.info(
          `[NaiPlusCommand] Generating ${numImages} images - first call LLM preprocessing, then loop generateImage`,
        );

        // First call: LLM preprocessing to get processed prompt
        // Check if plugin forces LLM processing (for SFW filter)
        const forceLLMProcess = context.conversationContext.metadata?.get('text2imgForceLLMProcess') === true;
        const skipLLMProcess = forceLLMProcess ? false : false; // Always false for first call in batch mode
        const firstResponse = await this.aiService.generateImg(
          hookContext,
          baseOptions,
          'novelai', // Force NovelAI provider
          skipLLMProcess,
          templateName,
        );

        // Get processed prompt from first response
        if (!firstResponse.prompt) {
          logger.warn('[NaiPlusCommand] First response does not contain processed prompt, falling back to user input');
        }

        // used in batch generation
        const processedPrompt = firstResponse.prompt || prompt;

        // Build first image message (unless silent mode)
        let firstImageSegments: MessageSegment[] | undefined;
        if (!silent) {
          const messageBuilder = buildMessageFromResponse(firstResponse, '[NaiPlusCommand]');
          firstImageSegments = messageBuilder.build();
        }

        // Generate remaining images with processed prompt (skip LLM processing)
        for (let i = 1; i < numImages; i++) {
          logger.info(`[NaiPlusCommand] Generating image ${i + 1}/${numImages} with processed prompt`);

          // Update seed for each image
          const currentSeed = generateSeed(baseSeed, i);
          const processedOptions = {
            ...baseOptions,
            prompt: processedPrompt,
            seed: currentSeed,
          };

          const response = await this.aiService.generateImg(
            hookContext,
            processedOptions,
            'novelai',
            true, // Skip LLM processing
            undefined,
          );
          // Build image message (unless silent mode)
          // Note: For batch generation, we only return the first image segments
          // Subsequent images would need to be sent separately or handled differently
          if (!silent && !firstImageSegments) {
            const messageBuilder = buildMessageFromResponse(response, '[NaiPlusCommand]');
            firstImageSegments = messageBuilder.build();
          }
        }

        return {
          success: true,
          segments: firstImageSegments,
        };
      }

      // Single image generation (original behavior)
      // Generate image using NovelAI provider with LLM preprocessing
      // Check if plugin forces LLM processing (for SFW filter)
      const forceLLMProcess = context.conversationContext.metadata?.get('text2imgForceLLMProcess') === true;
      const skipLLMProcess = forceLLMProcess ? false : false; // Always false for single image
      const finalTemplateName = templateName || 'text2img.generate_nai';
      const response = await this.aiService.generateImg(
        hookContext,
        baseOptions,
        'novelai', // Force NovelAI provider
        skipLLMProcess,
        finalTemplateName,
      );
      logger.info(`[NaiPlusCommand] Generated image with response: ${JSON.stringify(response)}`);

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
        const messageBuilder = buildMessageFromResponse(response, '[NaiPlusCommand]');
        imageSegments = messageBuilder.build();
      }

      return {
        success: true,
        segments: imageSegments,
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
