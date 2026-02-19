// Vision Service - provides vision/multimodal capability

import type { AIManager } from '../AIManager';
import type { VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import { isVisionCapability } from '../capabilities/VisionCapability';
import type { ProviderSelector } from '../ProviderSelector';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';
import { normalizeVisionImages } from '../utils/imageUtils';

/**
 * Vision Service
 * Provides vision/multimodal capability (text + images)
 */
export class VisionService {
  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {}

  /**
   * Generate text with vision (multimodal input)
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    if (images.length === 0) {
      throw new Error('At least one image is required for vision generation');
    }

    // Normalize images before passing to provider: always convert URL/file to base64, never pass URL to model
    const normalizedImages = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024, // 10MB default
    });

    // Determine which provider to use
    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('vision', providerName);
      if (p && isVisionCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Vision capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('vision', sessionProviderName);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Vision provider available');
      }
    }

    return await provider.generateWithVision(prompt, normalizedImages, options);
  }

  /**
   * Generate text with vision and streaming
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    if (images.length === 0) {
      throw new Error('At least one image is required for vision generation');
    }

    // Normalize images before passing to provider: always convert URL/file to base64, never pass URL to model
    const normalizedImages = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024, // 10MB default
    });

    // Determine which provider to use
    let provider: VisionCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('vision', providerName);
      if (p && isVisionCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support Vision capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'vision');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('vision', sessionProviderName);
        if (p && isVisionCapability(p)) {
          provider = p;
        }
      }
    }

    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('vision');
      if (defaultProvider && isVisionCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No Vision provider available');
      }
    }

    return await provider.generateStreamWithVision(prompt, normalizedImages, handler, options);
  }
}
