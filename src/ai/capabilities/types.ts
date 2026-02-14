// Capability type definitions

/**
 * Vision image input type
 * Supports multiple formats for image input
 */
export interface VisionImage {
  url?: string; // Image URL
  base64?: string; // Base64 encoded image
  file?: string; // Local file path
  mimeType?: string; // Image MIME type (image/jpeg, image/png, etc.)
}

/**
 * Text to image generation options
 */
export interface Text2ImageOptions {
  prompt: string; // Prompt to use for generation (must be provided by caller when calling generateImg, not extracted from message)
  width?: number;
  height?: number;
  aspectRatio?: string;
  imageSize?: string;
  numImages?: number;
  style?: string;
  quality?: 'standard' | 'hd';
  negative_prompt?: string; // Negative prompt for generation
  steps?: number; // Number of inference steps
  guidance_scale?: number; // Guidance scale (CFG)
  cfg_scale?: number;
  seed?: number; // Random seed for reproducibility
  model?: string; // Model to use for generation
  template?: string; // Template to use for generation
  [key: string]: unknown; // Allow provider-specific options
}

/**
 * Image to image transformation options
 */
export interface Image2ImageOptions {
  strength?: number; // How much to transform (0-1)
  noise?: number; // Noise for img2img (e.g. NovelAI), usually 0
  width?: number;
  height?: number;
  aspectRatio?: string;
  imageSize?: string;
  numImages?: number;
  model?: string; // Model to use for generation
  [key: string]: unknown; // Allow provider-specific options
}

/**
 * Provider image generation response (internal/intermediate type)
 * Used by providers to return images with relative paths or external URLs
 * This is converted to ImageGenerationResponse by ImageGenerationService
 */
export interface ProviderImageGenerationResponse {
  images: Array<{
    relativePath?: string; // Relative path from output directory (e.g., 'novelai/image.png') - for locally saved files
    url?: string; // External URL (for providers that return URLs directly, e.g., LocalText2ImageProvider)
    base64?: string; // Base64 encoded image (fallback if file save fails)
  }>;
  text?: string; // Text response from provider
  metadata?: Record<string, unknown>;
}

/**
 * Image generation response (final/public type)
 * Returned by ImageGenerationService to external callers
 * Contains only public URLs or base64, no internal paths
 */
export interface ImageGenerationResponse {
  images: Array<{
    url?: string; // Public URL (converted from relativePath by service layer)
    base64?: string; // Base64 encoded image (fallback if URL conversion fails)
  }>;
  text?: string; // Text response from provider
  metadata?: Record<string, unknown>;
  prompt?: string; // Processed prompt used for generation (useful for batch generation)
}

/**
 * Capability type identifiers
 */
export type CapabilityType = 'llm' | 'vision' | 'text2img' | 'img2img';
