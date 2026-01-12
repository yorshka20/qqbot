// Image Generation Service - provides image generation capabilities

import type { AIManager } from '../AIManager';
import type { ProviderSelector } from '../ProviderSelector';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import { isImage2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import { isText2ImageCapability } from '../capabilities/Text2ImageCapability';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';

/**
 * Image Generation Service
 * Provides text-to-image and image-to-image generation capabilities
 */
export class ImageGenerationService {
  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {}

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

    return await provider.generateImage(prompt, options);
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

    return await provider.transformImage(image, prompt, options);
  }
}
