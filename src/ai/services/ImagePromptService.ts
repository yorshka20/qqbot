// Image Prompt Service - provides image generation prompt preprocessing

import { logger } from '@/utils/logger';
import type { Text2ImageOptions } from '../capabilities/types';
import { PromptManager } from '../PromptManager';
import { LLMService } from './LLMService';

/**
 * Image Prompt Service
 * Provides image generation prompt preprocessing using LLM
 */
/** Default prompt when I2V LLM/parse fails or user input is empty */
export const DEFAULT_I2V_PROMPT = 'An1meStyl3, AnimeStyle, smooth animation';

/** Default and bounds for I2V video duration (seconds) */
export const DEFAULT_I2V_DURATION_SECONDS = 5;
export const MIN_I2V_DURATION_SECONDS = 1;
export const MAX_I2V_DURATION_SECONDS = 15;

export interface I2VPromptResult {
  prompt: string;
  durationSeconds: number;
  /** Optional negative prompt; if omitted, workflow uses default. */
  negativePrompt?: string;
}

export class ImagePromptService {
  // Constants for parameter limits (NovelAI specific)
  private static readonly MAX_STEPS = 50;
  private static readonly MAX_GUIDANCE_SCALE = 9;
  private static readonly DEFAULT_STEPS = 45;
  private static readonly DEFAULT_GUIDANCE_SCALE = 7;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;

  constructor(
    private llmService: LLMService,
    private promptManager: PromptManager,
  ) { }

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
      logger.warn(`[ImagePromptService] LLM preprocessing failed, falling back to direct user input | error=${llmErr.message}`);
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
    // Default template name: 'text2img.generate' (from prompts/text2img/generate.txt)
    // Can be overridden with templateName parameter (e.g., 'text2img.generate_nai')
    const llmPrompt = this.promptManager.render(templateName, {
      description: userInput,
    });

    logger.debug('[ImagePromptService] Calling LLM to preprocess image generation parameters...');

    // Call LLM to generate JSON parameters. use deepseek to generate prompt.
    const llmResponse = await this.llmService.generate(
      llmPrompt,
      {
        temperature: 0.3, // Lower temperature for more consistent JSON output
        maxTokens: 1000,
        sessionId,
      },
      'deepseek',
    );

    logger.debug(`[ImagePromptService] LLM response received | responseLength=${llmResponse.text.length}`);

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

    logger.info(
      `[ImagePromptService] LLM preprocessing completed | original="${userInput.substring(0, 50)}..." | processed="${parsedParams.prompt}" | steps=${processedOptions.steps} | cfg=${processedOptions.guidance_scale}`,
    );

    return {
      prompt: parsedParams.prompt,
      options: processedOptions,
    };
  }

  /**
   * Prepare prompt and duration for image-to-video (I2V) using LLM and template.
   * Used by the i2v command to convert user input into a Wan2.2-suitable motion prompt and duration (1–15s).
   * @param userInput - User description (can be empty; template will produce default)
   * @param sessionId - Session ID for LLM provider selection
   * @param templateName - Template name (default: 'img2video.generate')
   * @returns Processed prompt and durationSeconds (default 5, clamped 1–15)
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

      logger.debug('[ImagePromptService] Calling LLM to prepare I2V prompt...');

      const llmResponse = await this.llmService.generate(
        llmPrompt,
        {
          temperature: 0.3,
          maxTokens: 500,
          sessionId,
        },
        'deepseek',
      );

      const result = this.parseI2VPromptResponse(llmResponse.text);
      logger.info(
        `[ImagePromptService] I2V prompt prepared | input="${(userInput ?? '').substring(0, 40)}..." | prompt="${result.prompt.substring(0, 50)}..." | duration=${result.durationSeconds}s`,
      );
      return result;
    } catch (llmError) {
      const llmErr = llmError instanceof Error ? llmError : new Error('Unknown LLM error');
      logger.warn(`[ImagePromptService] I2V LLM preprocessing failed, using fallback | error=${llmErr.message}`);
      const prompt = (userInput ?? '').trim() || DEFAULT_I2V_PROMPT;
      return { prompt, durationSeconds: DEFAULT_I2V_DURATION_SECONDS };
    }
  }

  /**
   * Parse LLM response for I2V: expect JSON with "prompt", optional "duration_seconds", optional "negative_prompt".
   * Returns prompt string, duration 1–15 (default 5), and optional negative prompt.
   */
  private parseI2VPromptResponse(llmResponse: string): I2VPromptResult {
    let text = llmResponse.trim();
    // Strip markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      text = codeBlockMatch[1].trim();
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.prompt && typeof parsed.prompt === 'string') {
          let duration = typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : DEFAULT_I2V_DURATION_SECONDS;
          if (typeof parsed.duration_seconds === 'string') {
            const n = parseInt(parsed.duration_seconds, 10);
            if (!isNaN(n)) duration = n;
          }
          duration = Math.max(MIN_I2V_DURATION_SECONDS, Math.min(MAX_I2V_DURATION_SECONDS, Math.round(duration)));
          const result: I2VPromptResult = { prompt: parsed.prompt.trim(), durationSeconds: duration };
          if (typeof parsed.negative_prompt === 'string' && parsed.negative_prompt.trim()) {
            result.negativePrompt = parsed.negative_prompt.trim();
          }
          return result;
        }
      } catch {
        // Fall through
      }
    }
    const firstLine = text.split(/\r?\n/)[0]?.trim();
    const prompt = firstLine || text || DEFAULT_I2V_PROMPT;
    return { prompt, durationSeconds: DEFAULT_I2V_DURATION_SECONDS };
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
    logger.debug('[ImagePromptService] Using direct user input as prompt (LLM processing skipped)');

    const processedOptions = this.mergeAndValidateOptions(options);

    logger.info('[ImagePromptService] Using direct user input as prompt');

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
   * Parse LLM response to extract image generation parameters
   * Handles various response formats including JSON wrapped in markdown code blocks
   * @param llmResponse - Raw LLM response text
   * @param fallbackPrompt - Fallback prompt to use if parsing fails
   * @returns Parsed image generation parameters
   */
  private parseImageGenerationParams(
    llmResponse: string,
    fallbackPrompt: string,
  ): Text2ImageOptions {
    try {
      // Try to extract JSON from the response
      // Handle cases where JSON might be wrapped in markdown code blocks
      let jsonText = llmResponse.trim();

      // Remove markdown code block markers if present
      const jsonBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1].trim();
      }

      // Try to find JSON object in the text
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      // Parse JSON
      const parsed = JSON.parse(jsonText);

      // Validate required fields
      if (!parsed.prompt || typeof parsed.prompt !== 'string') {
        throw new Error('Missing or invalid prompt field in LLM response');
      }

      // Extract and validate parameters with defaults
      // Limit steps and cfg_scale to reasonable values (NovelAI typically uses steps 28-50, cfg 5-11)
      const result: Text2ImageOptions = {
        prompt: parsed.prompt as string,
        negative_prompt: (parsed.negative_prompt as string) || '',
        steps: this.validateNumber(parsed.steps, ImagePromptService.DEFAULT_STEPS, 1, ImagePromptService.MAX_STEPS),
        cfg_scale: this.validateNumber(
          parsed.cfg_scale,
          ImagePromptService.DEFAULT_GUIDANCE_SCALE,
          1,
          ImagePromptService.MAX_GUIDANCE_SCALE,
        ),
        seed: this.validateNumber(parsed.seed, -1, -1, Number.MAX_SAFE_INTEGER),
        width: this.validateNumber(parsed.width, ImagePromptService.DEFAULT_WIDTH, 256, 2048),
        height: this.validateNumber(parsed.height, ImagePromptService.DEFAULT_HEIGHT, 256, 2048),
        sampler: (parsed.sampler as string) || 'Euler a',
      };

      logger.debug(`[ImagePromptService] Successfully parsed LLM response | prompt="${result.prompt.substring(0, 50)}..."`);

      return result;
    } catch (parseError) {
      const parseErr = parseError instanceof Error ? parseError : new Error('Unknown parsing error');
      logger.warn(
        `[ImagePromptService] Failed to parse LLM response, using fallback | error=${parseErr.message} | response=${llmResponse.substring(0, 200)}`,
      );

      // Fallback: Return default parameters with user input as prompt
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
  }

  /**
   * Extract additional parameters from LLM JSON response
   * Some templates output parameters directly (e.g., aspectRatio, resolution) that should be mapped to options
   * This is a generic extractor that supports common parameter names from different templates
   * @param llmResponse - Raw LLM response text
   * @returns Additional parameters to merge into options
   */
  private extractAdditionalParamsFromLLMResponse(llmResponse: string): Partial<Text2ImageOptions> {
    try {
      // Try to extract JSON from the response
      let jsonText = llmResponse.trim();

      // Remove markdown code block markers if present
      const jsonBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1].trim();
      }

      // Try to find JSON object in the text
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      // Parse JSON
      const parsed = JSON.parse(jsonText);

      const result: Partial<Text2ImageOptions> = {};

      // Extract aspectRatio if present (e.g., from generate_banana.txt)
      if (parsed.aspectRatio && typeof parsed.aspectRatio === 'string') {
        result.aspectRatio = parsed.aspectRatio;
      }

      // Extract imageSize from resolution if present
      // Some templates output "resolution": "2K" or "4K" which should map to imageSize
      if (parsed.resolution && typeof parsed.resolution === 'string') {
        // Normalize to uppercase (e.g., "2k" -> "2K")
        result.imageSize = parsed.resolution.toUpperCase();
      }

      // Extract imageSize directly if present
      if (parsed.imageSize && typeof parsed.imageSize === 'string') {
        result.imageSize = parsed.imageSize.toUpperCase();
      }

      return result;
    } catch (error) {
      // If parsing fails, return empty object (no additional params extracted)
      return {};
    }
  }

  /**
   * Validate and normalize a number parameter
   * @param value - Value to validate
   * @param defaultValue - Default value if validation fails
   * @param min - Minimum allowed value
   * @param max - Maximum allowed value
   * @returns Validated number
   */
  private validateNumber(value: unknown, defaultValue: number, min: number, max: number): number {
    if (typeof value === 'number' && !isNaN(value)) {
      return Math.max(min, Math.min(max, value));
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) {
        return Math.max(min, Math.min(max, parsed));
      }
    }
    return defaultValue;
  }
}
