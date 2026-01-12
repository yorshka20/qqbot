// Local Text2Image Provider implementation - connects to local Python server

import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type { CapabilityType, ImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';

export interface LocalText2ImageProviderConfig {
  baseUrl: string; // Base URL of the Python server (e.g., http://localhost:8000)
  endpoint?: string; // API endpoint path (default: /generate)
  timeout?: number; // Request timeout in milliseconds (default: 300000 = 5 minutes)
  censorEnabled?: boolean; // Enable content censorship (default: true)
}

/**
 * Local Text2Image Provider implementation
 * Connects to a local Python server for text-to-image generation
 */
export class LocalText2ImageProvider extends AIProvider implements Text2ImageCapability {
  readonly name = 'local-text2img';
  private config: LocalText2ImageProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: LocalText2ImageProviderConfig) {
    super();
    this.config = {
      endpoint: '/generate',
      timeout: 300000, // 5 minutes default timeout for image generation
      censorEnabled: true,
      ...config,
    };

    // Explicitly declare supported capabilities
    this._capabilities = ['text2img'];

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
      const url = `${this.config.baseUrl}${this.config.endpoint}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout for health check

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: 'test',
          censor_enabled: this.config.censorEnabled,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Even if the request fails, if we get a response, the server is reachable
      return response.status !== 404;
    } catch (error) {
      logger.debug('[LocalText2ImageProvider] Availability check failed:', error);
      return false;
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
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('LocalText2ImageProvider is not available: baseUrl not configured');
    }

    try {
      const url = `${this.config.baseUrl}${this.config.endpoint}`;
      logger.debug(`[LocalText2ImageProvider] Generating image with prompt: ${prompt.substring(0, 50)}...`);

      // Build request body with all parameters
      const requestBody: Record<string, unknown> = {
        prompt,
        censor_enabled: this.config.censorEnabled,
      };

      // Add optional parameters from options
      if (options?.negative_prompt) {
        requestBody.negative_prompt = options.negative_prompt;
      }
      if (options?.steps !== undefined) {
        requestBody.steps = options.steps;
      }
      if (options?.width !== undefined) {
        requestBody.width = options.width;
      }
      if (options?.height !== undefined) {
        requestBody.height = options.height;
      }
      if (options?.guidance_scale !== undefined) {
        requestBody.guidance_scale = options.guidance_scale;
      }
      if (options?.seed !== undefined) {
        requestBody.seed = options.seed;
      }
      if (options?.numImages !== undefined) {
        requestBody.num_images = options.numImages;
      }

      // Add any additional provider-specific options
      for (const [key, value] of Object.entries(options || {})) {
        if (!['negative_prompt', 'steps', 'width', 'height', 'guidance_scale', 'seed', 'numImages'].includes(key)) {
          requestBody[key] = value;
        }
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(
          `LocalText2ImageProvider request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const data = (await response.json()) as {
        image?: string | string[];
        images?: string[];
        metadata?: Record<string, unknown>;
      };

      // Handle response format: { image } or { images: [...] }
      // Image can be base64 string or array of base64 strings
      let images: Array<{ base64?: string; url?: string }> = [];

      if (data.image) {
        // Single image response
        if (typeof data.image === 'string') {
          // Base64 string
          images.push({ base64: data.image });
        } else if (Array.isArray(data.image)) {
          // Array of base64 strings
          images = data.image.map((img: string) => ({ base64: img }));
        }
      } else if (data.images && Array.isArray(data.images)) {
        // Multiple images response
        images = data.images.map((img: string) => ({ base64: img }));
      } else {
        throw new Error('Invalid response format: expected "image" or "images" field');
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
      if (err.name === 'AbortError') {
        throw new Error(`LocalText2ImageProvider request timeout after ${this.config.timeout}ms`);
      }
      logger.error('[LocalText2ImageProvider] Generation failed:', err);
      throw err;
    }
  }
}
