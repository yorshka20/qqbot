// Local Text2Image Provider implementation - connects to local Python server

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type { CapabilityType, ProviderImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';

export interface LocalText2ImageProviderConfig {
  baseUrl: string; // Base URL of the Python server (e.g., http://localhost:8000)
  endpoint?: string; // API endpoint path (default: /generate)
  timeout?: number; // Request timeout in milliseconds (default: 300000 = 5 minutes)
  censorEnabled?: boolean; // Enable content censorship (default: true)
  // Default values for image generation parameters
  defaultSteps?: number; // Default number of inference steps (default: 25)
  defaultWidth?: number; // Default image width (default: 1024)
  defaultHeight?: number; // Default image height (default: 1024)
  defaultGuidanceScale?: number; // Default guidance scale (default: 5)
  defaultNumImages?: number; // Default number of images to generate (default: 1)
}

type LocalText2ImageResponse = {
  image_url?: string;
  image_urls?: string[];
  metadata?: Record<string, unknown>;
};

/**
 * Local Text2Image Provider implementation
 * Connects to a local Python server for text-to-image generation
 */
export class LocalText2ImageProvider extends AIProvider implements Text2ImageCapability {
  readonly name = 'local-text2img';
  private config: LocalText2ImageProviderConfig;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: LocalText2ImageProviderConfig) {
    super();
    this.config = {
      endpoint: '/generate',
      timeout: 300000, // 5 minutes default timeout for image generation
      censorEnabled: true,
      defaultSteps: 25,
      defaultWidth: 1024,
      defaultHeight: 1024,
      defaultGuidanceScale: 5,
      defaultNumImages: 1,
      ...config,
    };

    // Explicitly declare supported capabilities
    this._capabilities = ['text2img'];

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.config.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
      defaultTimeout: this.config.timeout,
    });

    logger.info('[LocalText2ImageProvider] Initialized', {
      baseUrl: this.config.baseUrl,
      endpoint: this.config.endpoint,
    });
  }

  isAvailable(): boolean {
    return !!this.config.baseUrl;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      await this.httpClient.post(
        this.config.endpoint!,
        {
          prompt: 'test',
          censor_enabled: this.config.censorEnabled,
        },
        { timeout: 5000 }, // 5 second timeout for health check
      );
      return true;
    } catch (error) {
      logger.debug('[LocalText2ImageProvider] Availability check failed:', error);
      // If we get a 404, the server is not reachable
      // Other errors might mean the server is reachable but the request is invalid
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      // For other errors, assume server is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      baseUrl: this.config.baseUrl,
      endpoint: this.config.endpoint,
      timeout: this.config.timeout,
      censorEnabled: this.config.censorEnabled,
    };
  }

  /**
   * Get capabilities supported by this provider
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('LocalText2ImageProvider is not available: baseUrl not configured');
    }

    try {
      logger.debug(`[LocalText2ImageProvider] Generating image with prompt: ${prompt}`);

      // Build request body with all parameters
      const requestBody: Record<string, unknown> = {
        prompt: `masterpiece, best quality, amazing quality, 4k, very aesthetic, high resolution, ultra-detailed, absurdres, newest, scenery, ${prompt}, BREAK, depth of field, volumetric lighting`,
        censor_enabled: this.config.censorEnabled,
      };

      requestBody.negative_prompt = `modern, recent, old, oldest, cartoon, graphic, text, painting, crayon, graphite, abstract, glitch, deformed, mutated, ugly, disfigured, long body, lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, very displeasing, (worst quality, bad quality:1.2), bad anatomy, sketch, jpeg artifacts, signature, watermark, username, signature, simple background, conjoined,bad ai-generated, ${options?.negative_prompt ?? ''}`;
      requestBody.steps = options?.steps || this.config.defaultSteps;
      requestBody.width = options?.width || this.config.defaultWidth;
      requestBody.height = options?.height || this.config.defaultHeight;
      requestBody.guidance_scale = options?.guidance_scale || this.config.defaultGuidanceScale;
      requestBody.num_images = options?.numImages || this.config.defaultNumImages;
      requestBody.seed = options?.seed && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 4294967295);

      // Add any additional provider-specific options
      for (const [key, value] of Object.entries(options || {})) {
        if (!['negative_prompt', 'steps', 'width', 'height', 'guidance_scale', 'seed', 'numImages'].includes(key)) {
          requestBody[key] = value;
        }
      }

      const data = await this.httpClient.post<LocalText2ImageResponse>(this.config.endpoint!, requestBody, {
        timeout: this.config.timeout,
      });

      // Handle response format: { image } or { images: [...] }
      // Image can be base64 string or array of base64 strings
      let images: Array<{ base64?: string; url?: string }> = [];

      if (data.image_url) {
        // Single image response
        images.push({ url: data.image_url });
      } else if (data.image_urls && Array.isArray(data.image_urls)) {
        // Multiple images response
        images = data.image_urls.map((url: string) => ({ url }));
      } else {
        throw new Error('Invalid response format: expected "image_url" or "image_urls" field');
      }

      logger.debug(`[LocalText2ImageProvider] Generated ${images.length} image(s)`);

      return {
        images,
        metadata: {
          prompt,
          numImages: images.length,
          ...(data.metadata || {}),
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[LocalText2ImageProvider] Generation failed:', err);
      throw err;
    }
  }
}
