// Image Generation Service - provides image generation capabilities

import { getStaticFileServer, StaticFileServer } from '@/utils/StaticFileServer';
import type { AIManager } from '../AIManager';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import { isImage2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import { isText2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  Image2ImageOptions,
  ImageGenerationResponse,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';
import type { ProviderSelector } from '../ProviderSelector';

/**
 * Image Generation Service
 * Provides text-to-image and image-to-image generation capabilities
 */
export class ImageGenerationService {
  private staticFileServer: StaticFileServer;

  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {
    this.staticFileServer = getStaticFileServer();
  }

  /**
   * Convert ProviderImageGenerationResponse (intermediate type) to ImageGenerationResponse (final type)
   *
   * Conversion rules:
   * - relativePath -> converted to public URL (relativePath is removed from final output)
   * - url -> kept as-is (for external URLs from providers like LocalText2ImageProvider)
   * - base64 -> kept as-is (fallback if no URL available)
   *
   * Final output contains ONLY url or base64, no internal paths (relativePath, filename, etc.)
   */
  private convertProviderResponseToFinal(response: ProviderImageGenerationResponse): ImageGenerationResponse {
    const convertedImages = response.images.map((image) => {
      // Priority 1: Convert relativePath to URL (relativePath is removed from final output)
      if (image.relativePath) {
        const url = this.staticFileServer.getFileURL(image.relativePath);
        return { url };
      }
      // Priority 2: Keep external URL as-is (from providers like LocalText2ImageProvider)
      if (image.url) {
        return { url: image.url };
      }
      // Priority 3: Fallback to base64
      return { base64: image.base64 };
    });

    // Return final response with only url/base64, no internal fields
    return {
      images: convertedImages,
      metadata: response.metadata,
    };
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(
    prompt: string,
    options?: Text2ImageOptions,
    sessionId?: string,
    providerName?: string,
  ): Promise<ImageGenerationResponse> {
    // Determine which provider to use
    let provider: Text2ImageCapability | null = null;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('text2img', providerName);
      if (p && isText2ImageCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Text2Image capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = this.providerSelector.getProviderForSession(sessionId, 'text2img');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('text2img', sessionProviderName);
        if (p && isText2ImageCapability(p)) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('text2img');
      if (defaultProvider && isText2ImageCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Text2Image provider available');
      }
    }

    const providerResponse = await provider.generateImage(prompt, options);
    // Convert provider response (with relativePath) to final response (with URL)
    return this.convertProviderResponseToFinal(providerResponse);
  }

  /**
   * Transform image based on prompt
   */
  async transformImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
    sessionId?: string,
    providerName?: string,
  ): Promise<ImageGenerationResponse> {
    // Determine which provider to use
    let provider: Image2ImageCapability | null = null;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('img2img', providerName);
      if (p && isImage2ImageCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Image2Image capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = this.providerSelector.getProviderForSession(sessionId, 'img2img');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('img2img', sessionProviderName);
        if (p && isImage2ImageCapability(p)) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('img2img');
      if (defaultProvider && isImage2ImageCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Image2Image provider available');
      }
    }

    const providerResponse = await provider.transformImage(image, prompt, options);
    // Convert provider response (with relativePath) to final response (with URL)
    return this.convertProviderResponseToFinal(providerResponse);
  }
}
