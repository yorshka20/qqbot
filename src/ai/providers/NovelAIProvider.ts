// NovelAI Provider implementation

import { HttpClient } from '@/api/http/HttpClient';
import type { NovelAIProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/**
 * NovelAI Provider implementation
 * Implements Text2Image and Image2Image capabilities
 * Supports both text-to-image and image-to-image generation
 */
export class NovelAIProvider extends AIProvider implements Text2ImageCapability, Image2ImageCapability {
  readonly name = 'novelai';
  private httpClient: HttpClient;
  private config: NovelAIProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: NovelAIProviderConfig) {
    super();
    this.config = {
      baseURL: 'https://api.novelai.net',
      defaultSteps: 28,
      defaultWidth: 832,
      defaultHeight: 1216,
      defaultGuidanceScale: 7,
      defaultStrength: 0.7,
      defaultNoise: 0.1,
      ...config,
    };

    // Explicitly declare supported capabilities
    this._capabilities = ['text2img', 'img2img'];

    // Configure HttpClient
    const baseURL = this.config.baseURL || 'https://api.novelai.net';
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${config.accessToken}`,
    };

    this.httpClient = new HttpClient({
      baseURL,
      defaultHeaders,
      defaultTimeout: 300000, // 5 minutes default timeout for image generation
    });

    if (this.isAvailable()) {
      logger.info('[NovelAIProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.accessToken;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      // NovelAI doesn't have a simple health check endpoint, so we'll try to get user info
      await this.httpClient.get('/user/information', { timeout: 5000 });
      return true;
    } catch (error) {
      logger.debug('[NovelAIProvider] Availability check failed:', error);
      // If we get a 401, the API is reachable but token is invalid
      // If we get a network error, the API is not reachable
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Other errors (like 401) mean the API is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      baseURL: this.config.baseURL,
      defaultSteps: this.config.defaultSteps,
      defaultWidth: this.config.defaultWidth,
      defaultHeight: this.config.defaultHeight,
      defaultGuidanceScale: this.config.defaultGuidanceScale,
    };
  }

  /**
   * Get capabilities supported by this provider
   * NovelAI supports both text-to-image and image-to-image generation
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    try {
      logger.debug(`[NovelAIProvider] Generating image with prompt: ${prompt}`);

      const parameters: Record<string, unknown> = {
        width: options?.width || this.config.defaultWidth || 832,
        height: options?.height || this.config.defaultHeight || 1216,
        scale: options?.guidance_scale || this.config.defaultGuidanceScale || 7,
        steps: options?.steps || this.config.defaultSteps || 28,
        n_samples: options?.numImages || 1,
      };

      // Add seed if provided
      if (options?.seed !== undefined) {
        parameters.seed = options.seed;
      }

      // Add negative prompt if provided
      if (options?.negative_prompt) {
        parameters.negative_prompt = options.negative_prompt;
      }

      const requestBody: Record<string, unknown> = {
        input: prompt,
        model: 'nai-diffusion-3',
        action: 'generate',
        parameters,
      };

      const response = await this.httpClient.post<{
        data: string[]; // Array of base64-encoded images
      }>('/ai/generate-image', requestBody, {
        timeout: 300000, // 5 minutes for image generation
      });

      // Convert base64 images to response format
      const images = (response.data || []).map((base64: string) => ({
        base64,
      }));

      logger.debug(`[NovelAIProvider] Generated ${images.length} image(s)`);

      return {
        images,
        metadata: {
          prompt,
          numImages: images.length,
          width: parameters.width,
          height: parameters.height,
          steps: parameters.steps,
          guidanceScale: parameters.scale,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[NovelAIProvider] Generation failed:', err);
      throw err;
    }
  }

  /**
   * Transform image based on prompt (img2img)
   */
  async transformImage(image: string, prompt: string, options?: Image2ImageOptions): Promise<ImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    try {
      logger.debug(`[NovelAIProvider] Transforming image with prompt: ${prompt}`);

      // Convert image to base64 using ResourceDownloader
      // Supports: URLs, data URLs, base64:// URIs, file paths, and raw base64 strings
      const imageBase64 = await ResourceDownloader.downloadToBase64(image, {
        timeout: 30000, // 30 seconds timeout for image download
        maxSize: 10 * 1024 * 1024, // 10MB maximum file size
      });

      const img2imgParameters: Record<string, unknown> = {
        width: options?.width || this.config.defaultWidth || 832,
        height: options?.height || this.config.defaultHeight || 1216,
        scale: this.config.defaultGuidanceScale || 7,
        steps: this.config.defaultSteps || 28,
        strength: options?.strength ?? this.config.defaultStrength ?? 0.7,
        noise: this.config.defaultNoise || 0.1,
        n_samples: options?.numImages || 1,
      };

      // Add seed if provided
      if (options?.seed !== undefined) {
        img2imgParameters.seed = options.seed;
      }

      const requestBody: Record<string, unknown> = {
        input: prompt,
        model: 'nai-diffusion-3',
        action: 'img2img',
        image: imageBase64,
        parameters: img2imgParameters,
      };

      const response = await this.httpClient.post<{
        data: string[]; // Array of base64-encoded images
      }>('/ai/generate-image', requestBody, {
        timeout: 300000, // 5 minutes for image generation
      });

      // Convert base64 images to response format
      const images = (response.data || []).map((base64: string) => ({
        base64,
      }));

      logger.debug(`[NovelAIProvider] Transformed ${images.length} image(s)`);

      return {
        images,
        metadata: {
          prompt,
          numImages: images.length,
          width: img2imgParameters.width,
          height: img2imgParameters.height,
          steps: img2imgParameters.steps,
          strength: img2imgParameters.strength,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[NovelAIProvider] Image transformation failed:', err);
      throw err;
    }
  }
}
