// Text2Image Capability interface - text to image generation capability

import type { AIProvider } from '../base/AIProvider';
import type { ProviderImageGenerationResponse, Text2ImageOptions } from './types';

/**
 * Text2Image Capability interface
 * Providers that support text-to-image generation should implement this interface
 * Returns ProviderImageGenerationResponse (internal type with relativePath)
 */
export interface Text2ImageCapability {
  /**
   * Generate image from text prompt
   * @returns ProviderImageGenerationResponse with relativePath or base64
   */
  generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse>;
}

/**
 * Type guard to check if a provider implements Text2ImageCapability
 * Checks if provider explicitly declared 'text2img' capability in getCapabilities()
 */
export function isText2ImageCapability(provider: unknown): provider is Text2ImageCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }

  // All providers extend AIProvider which has getCapabilities() method
  // Check if provider explicitly declared 'text2img' capability
  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('text2img');
}
