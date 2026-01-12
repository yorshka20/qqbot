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
  width?: number;
  height?: number;
  numImages?: number;
  style?: string;
  quality?: 'standard' | 'hd';
  negative_prompt?: string; // Negative prompt for generation
  steps?: number; // Number of inference steps
  guidance_scale?: number; // Guidance scale (CFG)
  seed?: number; // Random seed for reproducibility
  [key: string]: unknown; // Allow provider-specific options
}

/**
 * Image to image transformation options
 */
export interface Image2ImageOptions {
  strength?: number; // How much to transform (0-1)
  width?: number;
  height?: number;
  numImages?: number;
  [key: string]: unknown; // Allow provider-specific options
}

/**
 * Image generation response
 */
export interface ImageGenerationResponse {
  images: Array<{
    url?: string;
    base64?: string;
    file?: string;
  }>;
  metadata?: Record<string, unknown>;
}

/**
 * Capability type identifiers
 */
export type CapabilityType = 'llm' | 'vision' | 'text2img' | 'img2img';
