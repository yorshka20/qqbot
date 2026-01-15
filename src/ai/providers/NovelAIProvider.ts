// NovelAI Provider implementation

import type { NovelAIProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { mkdir, writeFile } from 'fs/promises';
import JSZip from 'jszip';
import { join } from 'path';
import { AIProvider } from '../base/AIProvider';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type { CapabilityType, ImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';

/**
 * NovelAI Provider implementation
 * Text-to-image generation using NovelAI API
 */
export class NovelAIProvider extends AIProvider implements Text2ImageCapability {
  readonly name = 'novelai';
  private config: NovelAIProviderConfig;
  private _capabilities: CapabilityType[];

  // Basic defaults
  private static readonly DEFAULT_STEPS = 45;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;
  private static readonly DEFAULT_GUIDANCE_SCALE = 5.0;

  constructor(config: NovelAIProviderConfig) {
    super();
    this.config = {
      baseURL: 'https://image.novelai.net',
      defaultSteps: NovelAIProvider.DEFAULT_STEPS,
      defaultWidth: NovelAIProvider.DEFAULT_WIDTH,
      defaultHeight: NovelAIProvider.DEFAULT_HEIGHT,
      defaultGuidanceScale: NovelAIProvider.DEFAULT_GUIDANCE_SCALE,
      ...config,
    };

    this._capabilities = ['text2img'];

    logger.info('[NovelAIProvider] Initialized');
  }

  isAvailable(): boolean {
    return !!this.config.accessToken;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    return true;
  }

  getConfig(): Record<string, unknown> {
    return {
      baseURL: this.config.baseURL,
      defaultSteps: this.config.defaultSteps,
      defaultWidth: this.config.defaultWidth,
      defaultHeight: this.config.defaultHeight,
      defaultGuidanceScale: this.config.defaultGuidanceScale,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Save base64 image data to local file
   */
  private async saveImageToFile(base64Data: string, prompt: string, seed?: number): Promise<string> {
    try {
      // Create output directory if it doesn't exist
      const outputDir = join(process.cwd(), 'output');
      await mkdir(outputDir, { recursive: true });

      // Generate filename based on timestamp, seed, and prompt hash
      const timestamp = Date.now();
      const promptHash = prompt.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_');
      const seedStr = seed !== undefined ? `_${seed}` : '';
      const filename = `novelai_${timestamp}${seedStr}_${promptHash}.png`;
      const filepath = join(outputDir, filename);

      // Convert base64 to buffer and save
      const imageBuffer = Buffer.from(base64Data, 'base64');
      await writeFile(filepath, imageBuffer);

      logger.info(`[NovelAIProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return filepath;
    } catch (error) {
      logger.warn(
        `[NovelAIProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  /**
   * Parse SSE (Server-Sent Events) stream to extract the final image
   */
  private async parseSSEStream(response: Response): Promise<string> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalImage = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line for next iteration

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6)); // Remove 'data: ' prefix

              if (data.image && data.event_type === 'intermediate') {
                // This is likely the final image (intermediate event with image data)
                finalImage = data.image;
              }
            } catch (e) {
              logger.warn(`[NovelAIProvider] Failed to parse SSE data: ${line}`);
            }
          }
        }
      }

      // Process any remaining data
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.image) {
                finalImage = data.image;
                logger.info(`[NovelAIProvider] Found final image in remaining data, length: ${finalImage.length}`);
              }
            } catch (e) {
              // Ignore parse errors for remaining buffer
            }
          }
        }
      }

      if (!finalImage) {
        throw new Error('No image found in SSE stream');
      }

      return finalImage;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Ensure complete download of response data using streaming
   * This prevents incomplete ZIP file downloads that can cause corruption
   */
  private async downloadComplete(response: Response): Promise<Buffer> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;
    }

    // Merge all chunks
    const allChunks = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      allChunks.set(chunk, position);
      position += chunk.length;
    }

    return Buffer.from(allChunks);
  }

  /**
   * Extract image from NovelAI ZIP response using JSZip
   * NovelAI returns a ZIP file containing the generated image
   */
  private async extractImageFromZip(buffer: Buffer): Promise<string> {
    logger.info(`[NovelAIProvider] Extracting image from ZIP (${buffer.length} bytes)`);

    // Validate ZIP signature
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      logger.error(`[NovelAIProvider] Invalid ZIP signature: ${buffer.subarray(0, 4).toString('hex')}`);
      throw new Error('Invalid ZIP file - corrupted or incomplete download');
    }

    try {
      logger.info(`[NovelAIProvider] Loading ZIP file...`);
      // Load ZIP file with JSZip
      const zip = await JSZip.loadAsync(buffer);

      // Get all entries (files) in the ZIP
      const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
      logger.info(`[NovelAIProvider] Found ${entries.length} files in ZIP: ${entries.join(', ')}`);

      if (entries.length === 0) {
        throw new Error('No files found in ZIP archive');
      }

      // Get the first image file (usually there's only one)
      const imageFile = zip.files[entries[0]];
      if (!imageFile) {
        throw new Error('Image file not found in ZIP');
      }

      logger.info(`[NovelAIProvider] Extracting ${entries[0]}...`);
      // Extract the image data as ArrayBuffer
      const imageBuffer = await imageFile.async('arraybuffer');

      // Convert to Node.js Buffer for PNG validation
      const nodeBuffer = Buffer.from(imageBuffer);
      logger.info(`[NovelAIProvider] Extracted ${nodeBuffer.length} bytes of image data`);

      // Verify it's a PNG
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (nodeBuffer.length < 8 || !nodeBuffer.subarray(0, 8).equals(pngSignature)) {
        logger.warn('[NovelAIProvider] Extracted file is not a valid PNG');
      } else {
        logger.info(`[NovelAIProvider] PNG signature validated`);
      }

      // Convert to base64
      const base64Data = nodeBuffer.toString('base64');
      logger.info(`[NovelAIProvider] Successfully extracted image (${base64Data.length} chars base64)`);

      return base64Data;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[NovelAIProvider] Failed to extract image from ZIP: ${err.message}`, err);
      throw new Error(`Failed to extract image from ZIP: ${err.message}`);
    }
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    try {
      logger.info(`[NovelAIProvider] Starting image generation for prompt: ${prompt}`);

      const steps = options?.steps || this.config.defaultSteps;
      const width = options?.width || this.config.defaultWidth;
      const height = options?.height || this.config.defaultHeight;
      const guidanceScale = options?.guidance_scale || this.config.defaultGuidanceScale;
      const seed =
        options?.seed !== undefined && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 4294967295);
      const model = this.config.model || 'nai-diffusion-4-5-full';

      const isV4Plus = model.startsWith('nai-diffusion-4');

      logger.info(
        `[NovelAIProvider] Parameters: model=${model}, size=${width}x${height}, steps=${steps}, scale=${guidanceScale}, seed=${seed}`,
      );

      // V4/V4.5 parameters according to the correct API spec
      const parameters: Record<string, unknown> = {
        params_version: 3,
        width,
        height,
        scale: guidanceScale,
        sampler: 'k_euler_ancestral',
        steps: 28, // hardcode to prevent points cost
        seed,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: false,
        noise_schedule: 'karras',
      };

      // For V4+ models, use v4_prompt and v4_negative_prompt structure
      if (isV4Plus) {
        parameters.v4_prompt = {
          caption: {
            base_caption: prompt,
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        };
        parameters.v4_negative_prompt = {
          caption: {
            base_caption:
              options?.negative_prompt ||
              'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page,bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, blurry, deformed, mutated, mutation, extra limbs, fused fingers, too many fingers, malformed limbs, gross proportions, long neck, disconnected limbs, poorly drawn hands, disfigured, extra limbs, missing limbs,lack of detail',
            char_captions: [],
          },
        };
      }

      const requestBody: Record<string, unknown> = {
        action: 'generate',
        model,
        parameters,
      };

      // For V3 models, use input field; for V4+ models, prompt is in parameters.v4_prompt
      if (!isV4Plus) {
        requestBody.input = prompt;
      }

      logger.info(`[NovelAIProvider] Request body: ${JSON.stringify(requestBody, null, 2)}`);

      const baseURL = this.config.baseURL || 'https://image.novelai.net';
      const fullUrl = baseURL.endsWith('/')
        ? `${baseURL}ai/generate-image-stream`
        : `${baseURL}/ai/generate-image-stream`;

      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // For streaming API (/generate-image-stream), parse SSE events
      if (fullUrl.includes('generate-image-stream')) {
        const streamImage = await this.parseSSEStream(response);
        const filepath = await this.saveImageToFile(streamImage, prompt, seed);
        return {
          images: [{ base64: streamImage }],
          metadata: { prompt, numImages: 1, width, height, steps, guidanceScale, filepath },
        };
      }

      // Fallback for non-streaming API (legacy support)
      const buffer = await this.downloadComplete(response);

      // Check if it's direct PNG binary data (legacy support)
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature)) {
        const base64Data = buffer.toString('base64');
        const filepath = await this.saveImageToFile(base64Data, prompt, seed);
        return {
          images: [{ base64: base64Data }],
          metadata: { prompt, numImages: 1, width, height, steps, guidanceScale, filepath },
        };
      }

      const base64Image = await this.extractImageFromZip(buffer);
      const filepath = await this.saveImageToFile(base64Image, prompt, seed);
      return {
        images: [{ base64: base64Image }],
        metadata: { prompt, numImages: 1, width, height, steps, guidanceScale, filepath },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[NovelAIProvider] Generation failed: ${err.message}`, err);
      throw err;
    }
  }
}
