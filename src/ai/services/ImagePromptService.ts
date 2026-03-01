// Image Prompt Service - provides image generation prompt preprocessing

import {
  AdditionalParamsSchema,
  type I2VPromptResult,
  I2VPromptResultSchema,
  T2IImageParamsSchema,
} from '@/ai/schemas';
import { type ExtractStrategy, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';
import type { Text2ImageOptions } from '../capabilities/types';
import type { PromptManager } from '../prompt/PromptManager';
import type { LLMService } from './LLMService';

/** Default and bounds for I2V video duration (seconds) */
export const DEFAULT_I2V_DURATION_SECONDS = 5;
export const MIN_I2V_DURATION_SECONDS = 1;
export const MAX_I2V_DURATION_SECONDS = 30;

/** I2V/T2I prompts expect JSON (often in ```json block). */
const IMAGE_PROMPT_JSON_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

/**
 * Image Prompt Service
 * Provides image generation prompt preprocessing using LLM
 */
export class ImagePromptService {
  private static readonly MAX_STEPS = 50;
  private static readonly MAX_GUIDANCE_SCALE = 9;
  private static readonly DEFAULT_STEPS = 45;
  private static readonly DEFAULT_GUIDANCE_SCALE = 7;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;

  constructor(
    private llmService: LLMService,
    private promptManager: PromptManager,
    private providerName: string,
  ) {}

  /**
   * Prepare image generation parameters
   * Either uses LLM preprocessing or directly uses user input based on skipLLMProcess flag
   * @param userInput - User input text
   * @param options - User-provided options
   * @param sessionId - Session ID for provider selection
   * @param skipLLMProcess - Whether to skip LLM preprocessing
   * @param templateName - Optional template name for LLM preprocessing (default: 'text2img.generate')
   * @returns Processed prompt and options
   */
  async prepareImageGenerationParams(
    userInput: string,
    options: Text2ImageOptions,
    sessionId: string,
    skipLLMProcess?: boolean,
    templateName?: string,
  ): Promise<{ prompt: string; options: Text2ImageOptions }> {
    if (skipLLMProcess) {
      return this.prepareDirectPrompt(userInput, options);
    }

    try {
      return await this.preprocessPromptWithLLM(userInput, options, sessionId, templateName);
    } catch (llmError) {
      const llmErr = llmError instanceof Error ? llmError : new Error('Unknown LLM error');
      logger.warn(
        `[ImagePromptService] LLM preprocessing failed, falling back to direct user input | error=${llmErr.message}`,
      );
      return this.prepareDirectPrompt(userInput, options);
    }
  }

  /**
   * Preprocess user input using LLM to generate standardized image generation parameters
   * @param userInput - User input text
   * @param options - User-provided options (will be merged with LLM-generated options)
   * @param sessionId - Session ID for provider selection
   * @param templateName - Optional template name (default: 'text2img.generate')
   * @returns Processed prompt and options
   */
  private async preprocessPromptWithLLM(
    userInput: string,
    options: Text2ImageOptions,
    sessionId: string,
    templateName: string = 'text2img.generate',
  ): Promise<{ prompt: string; options: Text2ImageOptions }> {
    // Build LLM prompt using PromptManager
    const llmPrompt = this.promptManager.render(templateName, {
      description: userInput,
    });

    // Call LLM to generate JSON parameters. use providerName to generate prompt.
    const llmResponse = await this.llmService.generate(
      llmPrompt,
      {
        temperature: 0.3, // Lower temperature for more consistent JSON output
        maxTokens: 1000,
        sessionId,
      },
      this.providerName,
    );

    // Parse LLM response to extract image generation parameters
    const parsedParams = this.parseImageGenerationParams(llmResponse.text, userInput);

    // Extract additional parameters from LLM JSON response that may not be in standard format
    // Some templates (like generate_banana.txt) output aspectRatio and resolution directly
    const additionalParams = this.extractAdditionalParamsFromLLMResponse(llmResponse.text);

    const processedOptions: Text2ImageOptions = {
      // Merge with user-provided options (user options take precedence)
      ...options,
      // fill parsedParams
      prompt: parsedParams.prompt,
      steps: parsedParams.steps,
      guidance_scale: parsedParams.cfg_scale,
      seed: parsedParams.seed,
      width: parsedParams.width,
      height: parsedParams.height,
      negative_prompt: parsedParams.negative_prompt,
      sampler: parsedParams.sampler,
      // Additional parameters from LLM response (aspectRatio, imageSize from resolution, etc.)
      ...additionalParams,
    };

    return {
      prompt: parsedParams.prompt,
      options: processedOptions,
    };
  }

  /**
   * Prepare prompt and duration for image-to-video (I2V) using LLM and template.
   * Used by the i2v command to convert user input into a Wan2.2-suitable motion prompt and duration (1–30s).
   * @param userInput - User description (can be empty; template will produce default)
   * @param sessionId - Session ID for LLM provider selection
   * @param templateName - Template name (default: 'img2video.generate')
   * @returns Processed prompt and durationSeconds (default 5, clamped 1–30)
   */
  async prepareI2VPrompt(
    userInput: string,
    sessionId: string,
    templateName: string = 'img2video.generate',
  ): Promise<I2VPromptResult> {
    try {
      const llmPrompt = this.promptManager.render(templateName, {
        description: userInput ?? '',
      });

      const llmResponse = await this.llmService.generate(
        llmPrompt,
        {
          temperature: 0.3,
          maxTokens: 1000,
          sessionId,
        },
        this.providerName,
      );
      const result = this.parseI2VPromptResponse(llmResponse.text, userInput);

      logger.info(`[ImagePromptService] I2V prompt prepared`, {
        input: userInput,
        prompt: result.prompt,
        duration: result.durationSeconds,
      });

      return result;
    } catch (llmError) {
      const llmErr = llmError instanceof Error ? llmError : new Error('Unknown LLM error');
      logger.warn(`[ImagePromptService] I2V LLM preprocessing failed, using fallback | error=${llmErr.message}`);
      const prompt = userInput.trim();
      return { prompt, durationSeconds: DEFAULT_I2V_DURATION_SECONDS };
    }
  }

  /**
   * Parse LLM response for I2V via schema. On parse failure, fallback to first line or default.
   */
  private parseI2VPromptResponse(llmResponse: string, userInput: string): I2VPromptResult {
    const text = llmResponse.trim();
    const result = parseLlmJson(text, I2VPromptResultSchema, { strategies: IMAGE_PROMPT_JSON_STRATEGIES });
    if (result != null) {
      return result;
    }
    logger.warn(`[ImagePromptService] Failed to parse I2V prompt response, using fallback | response=${text}`);
    return { prompt: userInput, durationSeconds: DEFAULT_I2V_DURATION_SECONDS };
  }

  /**
   * Prepare prompt and options directly from user input (skip LLM processing)
   * @param userInput - User input text
   * @param options - User-provided options
   * @returns Processed prompt and options
   */
  private prepareDirectPrompt(
    userInput: string,
    options: Text2ImageOptions,
  ): { prompt: string; options: Text2ImageOptions } {
    const processedOptions = this.mergeAndValidateOptions(options);

    return {
      prompt: userInput,
      options: processedOptions,
    };
  }

  /**
   * Merge user-provided options with defaults and apply validation limits
   * @param options - User-provided options
   * @returns Merged and validated options
   */
  private mergeAndValidateOptions(options: Text2ImageOptions): Text2ImageOptions {
    const mergedOptions: Text2ImageOptions = {
      seed: -1,
      width: options.width ?? ImagePromptService.DEFAULT_WIDTH,
      height: options.height ?? ImagePromptService.DEFAULT_HEIGHT,
      ...options, // Merge user-provided options
    };
    if (!mergedOptions.prompt) {
      throw new Error('options.prompt must be provided by caller');
    }

    // Apply limits to steps and guidance_scale after merge
    return {
      ...mergedOptions,
      steps: Math.min(mergedOptions.steps || ImagePromptService.DEFAULT_STEPS, ImagePromptService.MAX_STEPS),
      guidance_scale: Math.min(
        mergedOptions.guidance_scale || ImagePromptService.DEFAULT_GUIDANCE_SCALE,
        ImagePromptService.MAX_GUIDANCE_SCALE,
      ),
    };
  }

  /**
   * Parse LLM response to extract image generation parameters via schema. On failure, return fallback options.
   */
  private parseImageGenerationParams(llmResponse: string, fallbackPrompt: string): Text2ImageOptions {
    const result = parseLlmJson(llmResponse.trim(), T2IImageParamsSchema, {
      strategies: IMAGE_PROMPT_JSON_STRATEGIES,
    });
    if (result != null) {
      return result;
    }
    logger.warn(
      `[ImagePromptService] Failed to parse LLM response, using fallback | response=${llmResponse.substring(0, 200)}`,
    );
    return {
      prompt: fallbackPrompt,
      negative_prompt:
        'worst quality, low quality, bad anatomy, bad hands, text, error, jpeg artifacts, signature, watermark, blurry',
      steps: ImagePromptService.DEFAULT_STEPS,
      cfg_scale: ImagePromptService.DEFAULT_GUIDANCE_SCALE,
      seed: -1,
      width: ImagePromptService.DEFAULT_WIDTH,
      height: ImagePromptService.DEFAULT_HEIGHT,
      sampler: 'Euler a',
    };
  }

  /**
   * Extract additional parameters from LLM JSON response via schema (aspectRatio, resolution/imageSize).
   */
  private extractAdditionalParamsFromLLMResponse(llmResponse: string): Partial<Text2ImageOptions> {
    const result = parseLlmJson(llmResponse.trim(), AdditionalParamsSchema, {
      strategies: IMAGE_PROMPT_JSON_STRATEGIES,
    });
    return result ?? {};
  }
}
