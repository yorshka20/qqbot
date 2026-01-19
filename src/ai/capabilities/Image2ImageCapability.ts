// Image2Image Capability interface - image to image transformation capability

import type { AIProvider } from '../base/AIProvider';
import type { Image2ImageOptions, ProviderImageGenerationResponse } from './types';

/**
 * Image2Image Capability interface
 * Providers that support image-to-image generation should implement this interface
 * Returns ProviderImageGenerationResponse (internal type with relativePath)
 */
export interface Image2ImageCapability {
  /**
   * Generate image from image based on prompt (image-to-image generation)
   * @param image - Source image (URL, base64, or file path)
   * @param prompt - Generation prompt
   * @param options - Generation options
   * @returns ProviderImageGenerationResponse with relativePath or base64
   */
  generateImageFromImage(image: string, prompt: string, options?: Image2ImageOptions): Promise<ProviderImageGenerationResponse>;
}

/**
 * Type guard to check if a provider implements Image2ImageCapability
 * Checks if provider explicitly declared 'img2img' capability in getCapabilities()
 */
export function isImage2ImageCapability(provider: unknown): provider is Image2ImageCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }

  // All providers extend AIProvider which has getCapabilities() method
  // Check if provider explicitly declared 'img2img' capability
  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('img2img');
}
