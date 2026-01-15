// Gemini Provider implementation

import type { GeminiProviderConfig } from '@/core/config/ai';
import { logger } from '@/utils/logger';
import { GoogleGenAI } from '@google/genai';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AIProvider } from '../base/AIProvider';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type { CapabilityType, ProviderImageGenerationResponse, Text2ImageOptions } from '../capabilities/types';
import {
  handleFinishReason,
  handleGeneralError,
  handleInvalidContent,
  handleNoCandidates,
  handleNoImageData,
} from '../utils/geminiErrorHandler';

/**
 * Gemini Provider implementation
 * Text-to-image generation using Google Gemini API (nano banana)
 */
export class GeminiProvider extends AIProvider implements Text2ImageCapability {
  readonly name = 'gemini';
  private config: GeminiProviderConfig;
  private _capabilities: CapabilityType[];
  private client: GoogleGenAI;

  private outputPath = join(process.cwd(), 'output', 'gemini');

  // Default values
  private static readonly DEFAULT_MODEL = 'gemini-2.5-flash-image';
  private static readonly DEFAULT_WIDTH = 1024;
  private static readonly DEFAULT_HEIGHT = 1024;

  constructor(config: GeminiProviderConfig) {
    super();
    this.config = {
      model: GeminiProvider.DEFAULT_MODEL,
      defaultWidth: GeminiProvider.DEFAULT_WIDTH,
      defaultHeight: GeminiProvider.DEFAULT_HEIGHT,
      ...config,
    };

    this._capabilities = ['text2img'];

    // Initialize GoogleGenAI client
    // API key can be passed via config or GEMINI_API_KEY environment variable
    this.client = new GoogleGenAI({
      apiKey: this.config.apiKey,
    });

    logger.info('[GeminiProvider] Initialized');
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    return true;
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model,
      defaultWidth: this.config.defaultWidth,
      defaultHeight: this.config.defaultHeight,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Save image data to local file
   * Supports both Buffer and base64 string input
   * @returns Relative path from output directory (e.g., 'gemini/image.png') or null if save failed
   */
  private async saveImageToFile(imageData: Buffer | string, originalFilename: string): Promise<string | null> {
    try {
      const outputDir = this.outputPath;
      await mkdir(outputDir, { recursive: true });

      // Generate filename using timestamp and original filename
      const timestamp = Date.now();
      const filename = `${timestamp}_${originalFilename}`;
      const filepath = join(outputDir, filename);

      // Convert to buffer if needed
      let imageBuffer: Buffer;
      if (imageData instanceof Buffer) {
        imageBuffer = imageData;
      } else if (typeof imageData === 'string') {
        imageBuffer = Buffer.from(imageData, 'base64');
      } else {
        throw new Error('Invalid imageData type');
      }
      await writeFile(filepath, imageBuffer);

      // Build relative path: providerName/filename
      const relativePath = `gemini/${filename}`;

      logger.info(`[GeminiProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return relativePath;
    } catch (error) {
      logger.warn(
        `[GeminiProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GeminiProvider is not available: apiKey not configured');
    }

    try {
      logger.info(`[GeminiProvider] Starting image generation for prompt: ${prompt}`);

      const model = this.config.model || GeminiProvider.DEFAULT_MODEL;
      const width = options?.width || this.config.defaultWidth;
      const height = options?.height || this.config.defaultHeight;

      logger.info(`[GeminiProvider] Parameters: model=${model}, size=${width}x${height}`);

      const response = await this.client.models.generateContent({
        model,
        contents: prompt,
      });

      logger.debug(`[GeminiProvider] Response received`, response);

      // Response structure: candidates[0].content.parts[] with inlineData
      // Check for no candidates error
      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      // At this point, response.candidates is guaranteed to exist and have at least one element
      const candidate = response.candidates![0]!;

      // Check finish reason for errors
      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      // Check for invalid content structure
      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      // At this point, candidate.content and candidate.content.parts are guaranteed to exist
      const parts = candidate.content!.parts!;

      // Find image part in response
      let imageData: string | null = null;
      let text: string = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          text = part.text;
        } else if (part.inlineData) {
          const data = part.inlineData.data;
          if (data) {
            imageData = data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
      }

      if (!imageData) {
        // No image data found - check if there's a text explanation
        return handleNoImageData(text, prompt);
      }

      logger.info(`[GeminiProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      // Determine file extension from mime type
      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `gemini_image${extension}`;

      // Save image to local file
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      // Build response
      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        // Fallback to base64 if file save failed
        imageDataResponse.base64 = imageData;
        logger.warn('[GeminiProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          width,
          height,
          model,
          mimeType,
        },
      };
    } catch (error) {
      // Return error message in text field instead of throwing
      return handleGeneralError(error, prompt);
    }
  }
}
