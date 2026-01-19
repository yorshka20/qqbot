// Image utilities for converting message segments to VisionImage format

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import type { VisionImage } from '../capabilities/types';
import { ResourceDownloader } from './ResourceDownloader';

/**
 * Check if a URL is publicly accessible (not localhost or private IP)
 * Returns true if the URL is publicly accessible, false otherwise
 */
export function isPubliclyAccessibleURL(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check for localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }

    // Check for private IP ranges
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    if (hostname.startsWith('10.') || hostname.startsWith('172.') || hostname.startsWith('192.168.')) {
      return false;
    }

    // Check for link-local addresses
    if (hostname.startsWith('169.254.')) {
      return false;
    }

    return true;
  } catch {
    // If URL parsing fails, assume it's not publicly accessible
    return false;
  }
}

/**
 * Extract images from message segments
 * Supports both MessageSegment (standard format) and IncomingSegment (Milky protocol format)
 */
export function extractImagesFromSegments(segments: MessageSegment[]): VisionImage[] {
  const images: VisionImage[] = [];

  for (const segment of segments) {
    // Type guard: check if segment has type field
    if (typeof segment !== 'object' || segment === null || !('type' in segment)) {
      continue;
    }

    // Handle both MessageSegment and IncomingSegment types
    if (segment.type === 'image') {
      const imageData = segment.data;

      // Check if this is a sticker (sub_type === 'sticker')
      const imageType = imageData.sub_type || 'normal';

      // Log image segment data for debugging
      logger.debug(`[imageUtils] Processing ${imageType} image segment | data=${JSON.stringify(imageData)}`);

      const visionImage: VisionImage = {};

      // Priority 1: Handle Milky protocol uri field
      if (imageData.uri) {
        if (imageData.uri.startsWith('base64://')) {
          // Extract base64 data from base64:// URI
          const base64Data = imageData.uri.substring(9); // Remove 'base64://' prefix
          visionImage.base64 = base64Data;
          logger.debug(`[imageUtils] Extracted base64 from base64:// URI | base64Length=${base64Data.length}`);
        } else if (imageData.uri.startsWith('http://') || imageData.uri.startsWith('https://')) {
          visionImage.url = imageData.uri;
          logger.debug(`[imageUtils] Extracted URL from uri field | url=${imageData.uri}`);
        } else if (imageData.uri.startsWith('file://')) {
          visionImage.file = imageData.uri.substring(7); // Remove 'file://' prefix
          logger.debug(`[imageUtils] Extracted file path from file:// URI | file=${visionImage.file}`);
        } else {
          // Fallback: treat as URL
          visionImage.url = imageData.uri;
          logger.debug(`[imageUtils] Treating uri as URL | url=${imageData.uri}`);
        }
      }

      // Priority 2: Handle Milky protocol temp_url field
      // temp_url is a temporary download URL provided by Milky protocol
      // This is typically available for images received in messages
      if (imageData.temp_url && !visionImage.url && !visionImage.base64 && !visionImage.file) {
        visionImage.url = imageData.temp_url;
        logger.debug(`[imageUtils] Extracted URL from temp_url field | url=${imageData.temp_url}`);
      }

      // Priority 3: Handle Milky protocol resource_id field (fallback)
      // Note: resource_id is a Milky protocol specific field that identifies a resource
      // If temp_url is not available, we would need API call to get the actual resource URL
      // For now, we'll log it but won't handle it here (will need Milky API integration)
      if (imageData.resource_id && !visionImage.url && !visionImage.base64 && !visionImage.file) {
        logger.warn(
          `[imageUtils] Image segment has resource_id but no uri/temp_url field | resource_id=${imageData.resource_id} | summary=${imageData.summary || 'N/A'}`,
        );
        logger.warn(
          `[imageUtils] Milky protocol resource_id requires API call to get image URL - not implemented yet | resource_id=${imageData.resource_id}`,
        );
        // TODO: Implement Milky API call to get resource URL from resource_id
        // For now, skip this image as we can't process it without the actual URL/data
        continue;
      }

      // Try to infer MIME type from URL or file extension
      if (visionImage.url) {
        const urlLower = visionImage.url.toLowerCase();
        if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
          visionImage.mimeType = 'image/jpeg';
        } else if (urlLower.includes('.png')) {
          visionImage.mimeType = 'image/png';
        } else if (urlLower.includes('.gif')) {
          visionImage.mimeType = 'image/gif';
        } else if (urlLower.includes('.webp')) {
          visionImage.mimeType = 'image/webp';
        }
      } else if (visionImage.file) {
        const fileLower = visionImage.file.toLowerCase();
        if (fileLower.endsWith('.jpg') || fileLower.endsWith('.jpeg')) {
          visionImage.mimeType = 'image/jpeg';
        } else if (fileLower.endsWith('.png')) {
          visionImage.mimeType = 'image/png';
        } else if (fileLower.endsWith('.gif')) {
          visionImage.mimeType = 'image/gif';
        } else if (fileLower.endsWith('.webp')) {
          visionImage.mimeType = 'image/webp';
        }
      }

      // Validate that we have at least one valid field
      if (!visionImage.url && !visionImage.base64 && !visionImage.file) {
        logger.error(
          `[imageUtils] Image segment has no valid image data (url/base64/file) | segment=${JSON.stringify(segment)}`,
        );
        logger.error(`[imageUtils] Available fields in imageData: ${Object.keys(imageData).join(', ')}`);
        continue;
      }

      images.push(visionImage);
    }
  }

  logger.info(`[imageUtils] Extracted ${images.length} image(s) from ${segments.length} segment(s)`);

  return images;
}

/**
 * Check if message segments contain images
 */
export function hasImages(segments: MessageSegment[]): boolean {
  return segments.some((segment) => segment.type === 'image');
}

/**
 * Extract text from message segments (excluding images)
 */
export function extractTextFromSegments(segments: MessageSegment[]): string {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => (segment.type === 'text' ? segment.data.text : ''))
    .join('');
}

/**
 * Normalize vision images for AI providers
 * Converts local files and non-publicly accessible URLs to base64
 * This ensures all images can be accessed by external AI services
 *
 * @param images - Array of VisionImage objects to normalize
 * @param options - Options for normalization (timeout, maxSize, etc.)
 * @returns Normalized array of VisionImage objects (all have url or base64)
 */
export async function normalizeVisionImages(
  images: VisionImage[],
  options: {
    timeout?: number;
    maxSize?: number;
  } = {},
): Promise<VisionImage[]> {
  const normalized: VisionImage[] = [];
  const timeout = options.timeout ?? 30000;
  const maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default

  for (const image of images) {
    const normalizedImage: VisionImage = {
      mimeType: image.mimeType,
    };

    if (image.url) {
      // Check if URL is publicly accessible
      if (isPubliclyAccessibleURL(image.url)) {
        // Public URL - can be used directly by AI providers
        normalizedImage.url = image.url;
      } else {
        // Private/local URL - convert to base64
        try {
          const base64Data = await ResourceDownloader.downloadToBase64(image.url, {
            timeout,
            maxSize,
          });
          normalizedImage.base64 = base64Data;
          // Preserve mimeType if not already set
          if (!normalizedImage.mimeType) {
            normalizedImage.mimeType = 'image/jpeg';
          }
        } catch (error) {
          logger.error(`[imageUtils] Failed to convert URL to base64: ${image.url}`, error);
          throw new Error(`Failed to process image URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } else if (image.file) {
      // Local file path - convert to base64
      try {
        const base64Data = await ResourceDownloader.downloadToBase64(image.file, {
          timeout: 5000, // 5 seconds for local file
          maxSize,
        });
        normalizedImage.base64 = base64Data;
        // Preserve mimeType if not already set
        if (!normalizedImage.mimeType) {
          normalizedImage.mimeType = 'image/jpeg';
        }
      } catch (error) {
        logger.error(`[imageUtils] Failed to convert file to base64: ${image.file}`, error);
        throw new Error(`Failed to process image file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (image.base64) {
      // Base64 data - use as-is
      normalizedImage.base64 = image.base64;
    } else {
      // Log detailed error information for debugging
      logger.error(
        `[imageUtils] Invalid image format - no url, base64, or file field found | image=${JSON.stringify(image)}`,
      );
      throw new Error('Invalid image format. Must provide url, base64, or file.');
    }

    normalized.push(normalizedImage);
  }

  return normalized;
}

/**
 * Convert VisionImage to string format for use with image transformation APIs
 * Priority: url > base64 > file
 * @param image - VisionImage object to convert
 * @returns String representation (URL, base64, or file path)
 */
export function visionImageToString(image: VisionImage): string {
  if (image.url) {
    return image.url;
  }
  if (image.base64) {
    return image.base64;
  }
  if (image.file) {
    return image.file;
  }
  throw new Error('VisionImage has no valid url, base64, or file field');
}

/**
 * Extract reply message ID from reply segment
 * Supports both 'id' (standard) and 'message_seq' (Milky protocol) fields
 */
function extractReplyMessageId(segment: { type: string; data?: Record<string, unknown> }): number | null {
  if (segment.type !== 'reply' || !segment.data) {
    return null;
  }

  const id = segment.data.id ?? segment.data.message_seq;
  if (id === undefined || id === null) {
    return null;
  }

  const idNumber = typeof id === 'string' ? parseInt(id, 10) : Number(id);
  return isNaN(idNumber) ? null : idNumber;
}

/**
 * Extract images from referenced reply message
 */
async function extractImagesFromReplyMessage(
  replyMessageId: number,
  message: NormalizedMessageEvent,
  messageAPI: MessageAPI,
  databaseManager: DatabaseManager,
): Promise<VisionImage[]> {
  const referencedMessage = await messageAPI.getMessageFromContext(
    replyMessageId,
    message,
    databaseManager,
  );

  if (!referencedMessage.segments || referencedMessage.segments.length === 0) {
    return [];
  }

  return extractImagesFromSegments(referencedMessage.segments as MessageSegment[]);
}

/**
 * Extract images from message and its referenced reply message
 * Supports both current message images and images from referenced messages
 * @param message - NormalizedMessageEvent containing segments
 * @param messageAPI - MessageAPI instance for fetching referenced messages
 * @param databaseManager - DatabaseManager for querying database (required)
 * @returns Array of VisionImage objects extracted from current and referenced messages
 * @throws Error if referenced message cannot be retrieved
 */
export async function extractImagesFromMessageAndReply(
  message: NormalizedMessageEvent,
  messageAPI: MessageAPI,
  databaseManager: DatabaseManager,
): Promise<VisionImage[]> {
  const images: VisionImage[] = [];

  // Extract images from current message
  if (message.segments && message.segments.length > 0) {
    const currentImages = extractImagesFromSegments(message.segments as MessageSegment[]);
    images.push(...currentImages);
  }

  // Extract images from referenced reply message
  if (message.segments && message.segments.length > 0) {
    for (const segment of message.segments) {
      const replyMessageId = extractReplyMessageId(segment);
      if (replyMessageId === null) {
        continue;
      }

      try {
        logger.debug(`[imageUtils] Fetching referenced message | messageId=${replyMessageId}`);
        const referencedImages = await extractImagesFromReplyMessage(
          replyMessageId,
          message,
          messageAPI,
          databaseManager,
        );
        images.push(...referencedImages);
        if (referencedImages.length > 0) {
          logger.debug(`[imageUtils] Extracted ${referencedImages.length} image(s) from referenced message`);
        }
      } catch (error) {
        logger.error(
          `[imageUtils] Failed to extract images from referenced message | messageId=${replyMessageId} | error=${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      }
    }
  }

  logger.info(`[imageUtils] Extracted ${images.length} image(s) from message and reply`);
  return images;
}
