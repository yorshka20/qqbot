// Vision Capability interface - multimodal vision understanding capability

import type { AIProvider } from '../base/AIProvider';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';
import type { VisionImage } from './types';

/**
 * Vision Capability interface
 * Providers that support vision (image understanding) should implement this interface
 * Supports multimodal input: text + images
 */
export interface VisionCapability {
  /**
   * Generate text from prompt with vision (images)
   * Supports multimodal input: text prompt + images
   */
  generateWithVision(prompt: string, images: VisionImage[], options?: AIGenerateOptions): Promise<AIGenerateResponse>;

  /**
   * Generate text with vision and streaming support
   */
  generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse>;
}

/**
 * Vision Capability interface
 * Providers that support vision (image understanding) should implement this interface
 * Supports multimodal input: text + images
 */
export interface VisionCapability {
  /**
   * Generate text from prompt with vision (images)
   * Supports multimodal input: text prompt + images
   */
  generateWithVision(prompt: string, images: VisionImage[], options?: AIGenerateOptions): Promise<AIGenerateResponse>;

  /**
   * Generate text with vision and streaming support
   */
  generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse>;
}

/**
 * Type guard to check if a provider implements VisionCapability
 * Checks if provider explicitly declared 'vision' capability in getCapabilities()
 */
export function isVisionCapability(provider: unknown): provider is VisionCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }

  // All providers extend AIProvider which has getCapabilities() method
  // Check if provider explicitly declared 'vision' capability
  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('vision');
}
