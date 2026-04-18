// Image facade service — wraps image generation with hook lifecycle and prompt preprocessing.

import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';
import type { I2VPromptResult } from '../schemas';
import type { ImageGenerationService } from './ImageGenerationService';
import type { ImagePromptService } from './ImagePromptService';

/**
 * Image generation facade — wraps {@link ImageGenerationService} and
 * {@link ImagePromptService} with the standard hook lifecycle
 * (`onMessageBeforeAI` → `onAIGenerationStart` → generate → `onAIGenerationComplete`).
 * Handles text-to-image, image-to-image, and I2V prompt preparation.
 */
export class ImageFacadeService {
  constructor(
    private hookManager: HookManager,
    private imageGenerationService: ImageGenerationService,
    private imagePromptService: ImagePromptService,
  ) {}

  /**
   * Generate image from text prompt.
   * Runs hook lifecycle (onMessageBeforeAI → onAIGenerationStart → fn → onAIGenerationComplete).
   */
  async generateImg(
    context: HookContext,
    options: Text2ImageOptions,
    providerName?: string,
    skipLLMProcess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    return this.runWithHooks(context, 'Image generation interrupted by hook', async (sessionId) => {
      if (!options?.prompt) {
        throw new Error('options.prompt must be provided by caller');
      }
      const userInput = options.prompt;
      logger.debug(
        `[ImageFacadeService] Processing prompt | input=${userInput.substring(0, 50)}... | skipLLMProcess=${skipLLMProcess ?? false}`,
      );

      const prepared = await this.imagePromptService.prepareImageGenerationParams(
        userInput,
        options,
        sessionId ?? '',
        skipLLMProcess,
        templateName,
      );
      logger.info(
        `[ImageFacadeService] Generating image | prompt="${prepared.prompt.substring(0, 100)}..." | providerName=${providerName ?? 'default'}`,
      );

      const response = await this.imageGenerationService.generateImage(
        prepared.prompt,
        prepared.options,
        sessionId,
        providerName,
      );
      response.prompt = prepared.prompt;
      return response;
    });
  }

  /**
   * Transform image based on prompt (image-to-image).
   * Runs hook lifecycle around generation.
   */
  async generateImageFromImage(
    context: HookContext,
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
    providerName?: string,
    useLLMPreprocess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    return this.runWithHooks(context, 'Image transformation interrupted by hook', async (sessionId) => {
      if (!prompt?.trim()) {
        throw new Error('prompt must be provided for image transformation');
      }
      const finalPrompt = await this.resolveImageToImagePrompt(prompt, sessionId, useLLMPreprocess, templateName);
      logger.info(
        `[ImageFacadeService] Generating image from image | prompt="${finalPrompt}" | providerName=${providerName ?? 'default'}`,
      );
      return this.imageGenerationService.generateImageFromImage(image, finalPrompt, options, sessionId, providerName);
    });
  }

  /**
   * Prepare prompt and duration for image-to-video (I2V).
   */
  async prepareI2VPrompt(userInput: string, sessionId: string, templateName?: string): Promise<I2VPromptResult> {
    return this.imagePromptService.prepareI2VPrompt(userInput, sessionId, templateName ?? 'img2video.generate');
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Runs standard image-generation hook lifecycle around the given async function. */
  private async runWithHooks<T>(
    context: HookContext,
    interruptMessage: string,
    fn: (sessionId: string | undefined) => Promise<T>,
  ): Promise<T> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error(interruptMessage);
    }
    const sessionId = context.metadata.get('sessionId');
    await this.hookManager.execute('onAIGenerationStart', context);
    try {
      const result = await fn(sessionId);
      await this.hookManager.execute('onAIGenerationComplete', context);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ImageFacadeService] Image generation failed:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
    }
  }

  /** Resolves final prompt for img2img: optional LLM preprocessing. */
  private async resolveImageToImagePrompt(
    prompt: string,
    sessionId: string | undefined,
    useLLMPreprocess?: boolean,
    templateName?: string,
  ): Promise<string> {
    if (!useLLMPreprocess) {
      return prompt;
    }
    const prepared = await this.imagePromptService.prepareImageGenerationParams(
      prompt,
      { prompt },
      sessionId ?? '',
      false,
      templateName ?? 'text2img.generate',
    );
    logger.debug(`[ImageFacadeService] Image-from-image LLM preprocessing | input="${prompt}"`);
    return prepared.prompt;
  }
}
