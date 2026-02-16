// Image2Video Capability interface - image to video generation (I2V)

import type { AIProvider } from '../base/AIProvider';
import type { Image2VideoOptions } from './types';

/**
 * Image2Video Capability interface
 * Providers that support image-to-video generation should implement this interface
 */
export interface Image2VideoCapability {
  /**
   * Generate video from image and prompt (image-to-video)
   * @param imageBuffer - Source image as buffer
   * @param prompt - Generation prompt
   * @param options - Optional seed, durationSeconds, negativePrompt
   * @returns Video file as Buffer (e.g. mp4)
   */
  generateVideoFromImage(
    imageBuffer: Buffer,
    prompt: string,
    options?: Image2VideoOptions,
  ): Promise<Buffer>;
}

/**
 * Type guard to check if a provider implements Image2VideoCapability
 */
export function isImage2VideoCapability(provider: unknown): provider is Image2VideoCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }
  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('i2v');
}
