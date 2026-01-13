// Resource downloader utility - handles downloading and converting media resources to base64

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';

export interface ResourceDownloadOptions {
  /**
   * Timeout for downloading resources (default: 30000ms = 30 seconds)
   */
  timeout?: number;
  /**
   * Maximum file size in bytes (default: 10MB)
   * Set to 0 to disable size check
   *
   * Common limits:
   * - Anthropic Claude API: 5MB per image
   * - OpenAI GPT-4 Vision: 20MB per image
   * - General recommendation: 10MB for most use cases
   */
  maxSize?: number;
  /**
   * Directory path to save downloaded files locally
   * If provided, the file will be saved after download
   * Example: './data/downloads' or '/tmp/resources'
   * If not provided, files will not be saved locally
   */
  savePath?: string;
  /**
   * Custom filename for saved file (optional)
   * If not provided, filename will be generated from URL or resource hash
   * Example: 'my-image.png'
   */
  filename?: string;
}

/**
 * Resource downloader utility
 * Handles downloading and converting various media resources (images, videos, audio) to base64
 * Supports multiple input formats:
 * - HTTP/HTTPS URLs
 * - Data URLs (data:image/png;base64,...)
 * - Base64 URI format (base64://...)
 * - File paths (local files)
 * - Raw base64 strings
 */
export class ResourceDownloader {
  private static defaultHttpClient: HttpClient | null = null;
  private static defaultSavePath: string = './output/resources';

  /**
   * Get or create default HttpClient instance
   */
  private static getHttpClient(timeout: number): HttpClient {
    if (!this.defaultHttpClient) {
      this.defaultHttpClient = new HttpClient({
        defaultTimeout: timeout,
      });
    }
    return this.defaultHttpClient;
  }

  /**
   * Download and convert resource to base64 string
   *
   * @param resource - Resource identifier (URL, data URL, file path, or base64 string)
   * @param options - Download options
   * @returns Base64 encoded string (without data URL prefix)
   *
   * @example
   * ```typescript
   * // Download from URL
   * const base64 = await ResourceDownloader.downloadToBase64('https://example.com/image.png');
   *
   * // Download and save to local directory
   * const base64 = await ResourceDownloader.downloadToBase64('https://example.com/image.png', {
   *   savePath: './data/downloads',
   * });
   *
   * // Use data URL
   * const base64 = await ResourceDownloader.downloadToBase64('data:image/png;base64,iVBORw0KG...');
   *
   * // Use file path
   * const base64 = await ResourceDownloader.downloadToBase64('/path/to/image.png');
   *
   * // Use base64 URI
   * const base64 = await ResourceDownloader.downloadToBase64('base64://iVBORw0KG...');
   * ```
   */
  static async downloadToBase64(resource: string, options: ResourceDownloadOptions = {}): Promise<string> {
    const timeout = options.timeout ?? 30000; // 30 seconds default
    const maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default
    const savePath = options.savePath ?? this.defaultSavePath;

    try {
      // Handle data URL format: data:image/png;base64,...
      if (resource.startsWith('data:')) {
        const commaIndex = resource.indexOf(',');
        if (commaIndex === -1) {
          throw new Error('Invalid data URL format: missing comma separator');
        }
        const base64Data = resource.substring(commaIndex + 1);

        // Save to local file if savePath is provided
        if (savePath) {
          const buffer = Buffer.from(base64Data, 'base64');
          // Try to extract MIME type from data URL
          const mimeTypeMatch = resource.match(/data:([^;]+)/);
          const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'application/octet-stream';
          const filePath = this.saveFile(buffer, resource, savePath, options.filename, mimeType);
          logger.debug(`[ResourceDownloader] Saved file to: ${filePath}`);
        }

        logger.debug('[ResourceDownloader] Extracted base64 from data URL');
        return base64Data;
      }

      // Handle base64 URI format: base64://...
      if (resource.startsWith('base64://')) {
        const base64Data = resource.substring(9); // Remove 'base64://' prefix

        // Save to local file if savePath is provided
        if (savePath) {
          const buffer = Buffer.from(base64Data, 'base64');
          const filePath = this.saveFile(buffer, resource, savePath, options.filename);
          logger.debug(`[ResourceDownloader] Saved file to: ${filePath}`);
        }

        logger.debug('[ResourceDownloader] Extracted base64 from base64:// URI');
        return base64Data;
      }

      // Handle HTTP/HTTPS URLs
      if (resource.startsWith('http://') || resource.startsWith('https://')) {
        logger.debug(`[ResourceDownloader] Downloading resource from URL: ${resource}`);
        const httpClient = this.getHttpClient(timeout);
        const arrayBuffer = await httpClient.get<ArrayBuffer>(resource);

        // Check file size if maxSize is set
        if (maxSize > 0 && arrayBuffer.byteLength > maxSize) {
          throw new Error(
            `Resource size (${arrayBuffer.byteLength} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
          );
        }

        // Save to local file if savePath is provided
        if (savePath) {
          const buffer = Buffer.from(arrayBuffer);
          const filePath = this.saveFile(buffer, resource, savePath, options.filename);
          logger.debug(`[ResourceDownloader] Saved file to: ${filePath}`);
        }

        // Convert ArrayBuffer to base64
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        logger.debug(
          `[ResourceDownloader] Downloaded and converted resource to base64 (${arrayBuffer.byteLength} bytes)`,
        );
        return base64;
      }

      // Handle file:// URI format
      if (resource.startsWith('file://')) {
        const filePath = resource.substring(7); // Remove 'file://' prefix
        logger.debug(`[ResourceDownloader] Reading file: ${filePath}`);
        return this.readFileToBase64(filePath, maxSize);
      }

      // Try to read as local file path
      try {
        logger.debug(`[ResourceDownloader] Attempting to read as file: ${resource}`);
        return this.readFileToBase64(resource, maxSize);
      } catch (fileError) {
        // If file read fails, assume it's already a base64 string
        logger.debug('[ResourceDownloader] File read failed, treating as raw base64 string');
        // Validate base64 format (basic check)
        if (this.isValidBase64(resource)) {
          return resource;
        }
        throw new Error(
          `Invalid resource format: not a valid URL, file path, or base64 string. File error: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[ResourceDownloader] Failed to download/convert resource: ${err.message}`);
      throw new Error(`Failed to download resource: ${err.message}`);
    }
  }

  /**
   * Read file and convert to base64
   */
  private static readFileToBase64(filePath: string, maxSize: number): string {
    try {
      const fileBuffer = readFileSync(filePath);

      // Check file size if maxSize is set
      if (maxSize > 0 && fileBuffer.length > maxSize) {
        throw new Error(`File size (${fileBuffer.length} bytes) exceeds maximum allowed size (${maxSize} bytes)`);
      }

      const base64 = fileBuffer.toString('base64');
      logger.debug(`[ResourceDownloader] Read file and converted to base64 (${fileBuffer.length} bytes)`);
      return base64;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to read file ${filePath}: ${err.message}`);
    }
  }

  /**
   * Basic validation for base64 string
   * Checks if string contains only valid base64 characters
   */
  private static isValidBase64(str: string): boolean {
    // Base64 characters: A-Z, a-z, 0-9, +, /, = (padding)
    // Allow whitespace for better compatibility
    const base64Regex = /^[A-Za-z0-9+/=\s]+$/;
    return base64Regex.test(str) && str.length > 0;
  }

  /**
   * Save file to local directory
   */
  private static saveFile(
    buffer: Buffer,
    resource: string,
    savePath: string,
    customFilename?: string,
    mimeType?: string,
  ): string {
    try {
      // Ensure directory exists
      if (!existsSync(savePath)) {
        mkdirSync(savePath, { recursive: true });
        logger.debug(`[ResourceDownloader] Created directory: ${savePath}`);
      }

      // Generate filename
      let filename: string;
      if (customFilename) {
        filename = customFilename;
      } else {
        // Try to extract filename from URL
        if (resource.startsWith('http://') || resource.startsWith('https://')) {
          try {
            const url = new URL(resource);
            const urlFilename = basename(url.pathname);
            if (urlFilename && urlFilename !== '/') {
              filename = urlFilename;
            } else {
              // Generate filename from URL hash
              filename = this.generateFilenameFromResource(resource, mimeType);
            }
          } catch {
            filename = this.generateFilenameFromResource(resource, mimeType);
          }
        } else {
          // Generate filename from resource hash
          filename = this.generateFilenameFromResource(resource, mimeType);
        }
      }

      // Ensure filename has extension
      if (!extname(filename)) {
        const extension = this.getExtensionFromMimeType(mimeType) || '.bin';
        filename = `${filename}${extension}`;
      }

      const filePath = join(savePath, filename);
      writeFileSync(filePath, buffer);
      logger.debug(`[ResourceDownloader] Saved file: ${filePath} (${buffer.length} bytes)`);
      return filePath;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn(`[ResourceDownloader] Failed to save file: ${err.message}`);
      // Don't throw error, just log warning - saving is optional
      throw err;
    }
  }

  /**
   * Generate filename from resource (using hash)
   */
  private static generateFilenameFromResource(resource: string, mimeType?: string): string {
    const hash = createHash('md5').update(resource).digest('hex').substring(0, 12);
    const extension = this.getExtensionFromMimeType(mimeType) || '.bin';
    return `${hash}${extension}`;
  }

  /**
   * Get file extension from MIME type
   */
  private static getExtensionFromMimeType(mimeType?: string): string | null {
    if (!mimeType) return null;

    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'text/plain': '.txt',
    };

    return mimeToExt[mimeType.toLowerCase()] || null;
  }

  /**
   * Download multiple resources in parallel
   *
   * @param resources - Array of resource identifiers
   * @param options - Download options
   * @returns Array of base64 strings in the same order as input
   */
  static async downloadMultipleToBase64(resources: string[], options: ResourceDownloadOptions = {}): Promise<string[]> {
    return Promise.all(resources.map((resource) => this.downloadToBase64(resource, options)));
  }
}
