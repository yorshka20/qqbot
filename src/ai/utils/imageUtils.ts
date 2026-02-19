// Image utilities for converting message segments to VisionImage format

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import type { VisionImage } from '../capabilities/types';
import { compressImageToMaxBytes } from './imageResize';
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
 * Build a single VisionImage from segment.data using only uri and temp_url (no resource_id).
 * Used as fallback when get_resource_temp_url is not available or when temp_url might still be valid.
 */
function buildVisionImageFromUriAndTempUrl(imageData: Record<string, unknown> | undefined): VisionImage | null {
  if (!imageData || typeof imageData !== 'object') return null;
  const visionImage: VisionImage = {};

  // Priority 1: Handle Milky protocol uri field
  if (imageData.uri && typeof imageData.uri === 'string') {
    if (imageData.uri.startsWith('base64://')) {
      // Extract base64 data from base64:// URI
      visionImage.base64 = imageData.uri.substring(9); // Remove 'base64://' prefix
    } else if (
      imageData.uri.startsWith('http://') ||
      imageData.uri.startsWith('https://') ||
      imageData.uri.startsWith('file://')
    ) {
      if (imageData.uri.startsWith('file://')) {
        visionImage.file = imageData.uri.substring(7); // Remove 'file://' prefix
      } else {
        visionImage.url = imageData.uri;
      }
    } else {
      // Fallback: treat as URL
      visionImage.url = imageData.uri;
    }
  }
  // Priority 2: Handle Milky protocol temp_url field
  // temp_url is a temporary download URL provided by Milky protocol
  // This is typically available for images received in messages
  if (
    imageData.temp_url &&
    typeof imageData.temp_url === 'string' &&
    !visionImage.url &&
    !visionImage.base64 &&
    !visionImage.file
  ) {
    visionImage.url = imageData.temp_url;
  }

  if (!visionImage.url && !visionImage.base64 && !visionImage.file) return null;

  // Try to infer MIME type from URL or file extension
  if (visionImage.url) {
    const urlLower = visionImage.url.toLowerCase();
    if (urlLower.includes('.png')) visionImage.mimeType = 'image/png';
    else if (urlLower.includes('.gif')) visionImage.mimeType = 'image/gif';
    else if (urlLower.includes('.webp')) visionImage.mimeType = 'image/webp';
    else visionImage.mimeType = 'image/jpeg';
  } else if (visionImage.file) {
    const fileLower = (visionImage.file as string).toLowerCase();
    if (fileLower.endsWith('.png')) visionImage.mimeType = 'image/png';
    else if (fileLower.endsWith('.gif')) visionImage.mimeType = 'image/gif';
    else if (fileLower.endsWith('.webp')) visionImage.mimeType = 'image/webp';
    else visionImage.mimeType = 'image/jpeg';
  }
  return visionImage;
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
      const imageData = segment.data as Record<string, unknown> | undefined;

      // Check if this is a sticker (sub_type === 'sticker')
      const imageType = imageData?.sub_type || 'normal';

      // Log image segment data for debugging
      logger.debug(`[imageUtils] Processing ${imageType} image segment | data=${JSON.stringify(imageData)}`);

      const visionImage = buildVisionImageFromUriAndTempUrl(imageData);
      if (visionImage) {
        images.push(visionImage);
      } else if (imageData?.resource_id) {
        // Priority 3: When only resource_id is present, use extractImagesFromSegmentsAsync with getResourceUrl to resolve via get_resource_temp_url
        logger.warn(
          `[imageUtils] Image segment has resource_id but no uri/temp_url | resource_id=${imageData.resource_id} | Use extractImagesFromSegmentsAsync with getResourceUrl to resolve`,
        );
      }
    }
  }

  logger.info(`[imageUtils] Extracted ${images.length} image(s) from ${segments.length} segment(s)`);
  return images;
}

/**
 * Extract images from segments with optional resolution of Milky resource_id via get_resource_temp_url.
 * When getResourceUrl is provided: prefer resolving resource_id to a fresh URL (so expired temp_url is not used);
 * if that fails or resource_id is missing, fall back to uri/temp_url. Never skip an image when segment has resource_id or uri/temp_url.
 * @param segments - Message segments
 * @param getResourceUrl - Optional callback to resolve resource_id to URL (e.g. MessageAPI.getResourceTempUrl)
 * @returns Promise of VisionImage array
 */
export async function extractImagesFromSegmentsAsync(
  segments: MessageSegment[],
  getResourceUrl?: (resourceId: string) => Promise<string | null>,
): Promise<VisionImage[]> {
  const images: VisionImage[] = [];
  if (!segments?.length) return images;

  for (const segment of segments) {
    if (typeof segment !== 'object' || segment === null || !('type' in segment) || segment.type !== 'image') {
      continue;
    }
    const imageData = segment.data as Record<string, unknown> | undefined;
    let visionImage: VisionImage | null = null;

    // Prefer fresh URL from resource_id when available (avoids using expired temp_url)
    if (imageData?.resource_id && typeof imageData.resource_id === 'string' && getResourceUrl) {
      try {
        const url = await getResourceUrl(imageData.resource_id);
        if (url) {
          visionImage = { url };
          if (url.toLowerCase().includes('.png')) visionImage.mimeType = 'image/png';
          else if (url.toLowerCase().includes('.gif')) visionImage.mimeType = 'image/gif';
          else if (url.toLowerCase().includes('.webp')) visionImage.mimeType = 'image/webp';
          else visionImage.mimeType = 'image/jpeg';
          logger.debug(`[imageUtils] Using fresh URL from get_resource_temp_url for resource_id`);
        }
      } catch (err) {
        logger.warn(
          `[imageUtils] get_resource_temp_url failed, falling back to uri/temp_url | resourceId=${String(imageData.resource_id).substring(0, 30)}... | error=${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    }

    // Fallback: use uri or temp_url (e.g. when no getResourceUrl, or getResourceUrl returned null / threw)
    if (!visionImage) {
      visionImage = buildVisionImageFromUriAndTempUrl(imageData);
    }

    if (visionImage) {
      images.push(visionImage);
    } else if (imageData?.resource_id) {
      logger.warn(
        `[imageUtils] Image segment has only resource_id and getResourceUrl failed or not provided; image skipped | resource_id=${String(imageData.resource_id).substring(0, 30)}...`,
      );
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
 * Always converts URLs and local files to base64 before passing to the model.
 * We never send raw URLs to the model - providers receive only base64 (or data URL from base64)
 * so that temporary/private URLs (e.g. QQ multimedia) are fetched by our server and never by the provider.
 *
 * @param images - Array of VisionImage objects to normalize
 * @param options - Options for normalization (timeout, maxSize, maxBytesForVision, etc.)
 * @returns Normalized array of VisionImage objects (all have base64; url is never passed through)
 */
const VISION_IMAGE_MAX_BYTES = 500 * 1024; // 500 KB - compress images exceeding this before sending to model

export async function normalizeVisionImages(
  images: VisionImage[],
  options: {
    timeout?: number;
    maxSize?: number;
    maxBytesForVision?: number;
  } = {},
): Promise<VisionImage[]> {
  const normalized: VisionImage[] = [];
  const timeout = options.timeout ?? 30000;
  const maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default for download
  const maxBytesForVision = options.maxBytesForVision ?? VISION_IMAGE_MAX_BYTES;

  for (const image of images) {
    const normalizedImage: VisionImage = {
      mimeType: image.mimeType,
    };

    if (image.url) {
      // Always download and convert URL to base64 - never pass URL to the model
      try {
        const base64Data = await ResourceDownloader.downloadToBase64(image.url, {
          timeout,
          maxSize,
        });
        normalizedImage.base64 = base64Data;
        if (!normalizedImage.mimeType) {
          normalizedImage.mimeType = 'image/jpeg';
        }
      } catch (error) {
        logger.error(`[imageUtils] Failed to convert URL to base64: ${image.url}`, error);
        throw new Error(`Failed to process image URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (image.file) {
      try {
        const base64Data = await ResourceDownloader.downloadToBase64(image.file, {
          timeout: 5000,
          maxSize,
        });
        normalizedImage.base64 = base64Data;
        if (!normalizedImage.mimeType) {
          normalizedImage.mimeType = 'image/jpeg';
        }
      } catch (error) {
        logger.error(`[imageUtils] Failed to convert file to base64: ${image.file}`, error);
        throw new Error(`Failed to process image file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (image.base64) {
      normalizedImage.base64 = image.base64;
    } else {
      logger.error(
        `[imageUtils] Invalid image format - no url, base64, or file field found | image=${JSON.stringify(image)}`,
      );
      throw new Error('Invalid image format. Must provide url, base64, or file.');
    }

    // Compress if over limit so vision APIs receive images <= 500 KB
    const decodedLength = Buffer.byteLength(normalizedImage.base64!, 'base64');
    if (decodedLength > maxBytesForVision) {
      try {
        const compressed = await compressImageToMaxBytes(normalizedImage.base64!, maxBytesForVision);
        normalizedImage.base64 = compressed.base64;
        normalizedImage.mimeType = compressed.mimeType;
        const newDecodedLength = Buffer.from(compressed.base64, 'base64').length;
        logger.debug(`[imageUtils] Vision image compressed from ${decodedLength} to ${newDecodedLength} bytes`);
      } catch (error) {
        logger.warn(`[imageUtils] Compression failed, using original image: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
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
 * Convert VisionImage to Buffer for APIs that need raw bytes (e.g. ComfyUI upload).
 * For url/file, downloads and returns buffer; for base64, decodes in-place.
 */
export async function visionImageToBuffer(
  image: VisionImage,
  options?: { timeout?: number; maxSize?: number },
): Promise<Buffer> {
  const timeout = options?.timeout ?? 30000;
  const maxSize = options?.maxSize ?? 10 * 1024 * 1024; // 10MB default

  if (image.base64) {
    return Buffer.from(image.base64, 'base64');
  }
  if (image.url || image.file) {
    const source = image.url ?? image.file!;
    const base64Data = await ResourceDownloader.downloadToBase64(source, {
      timeout,
      maxSize,
    });
    return Buffer.from(base64Data, 'base64');
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

  const getResourceUrl = (resourceId: string) => messageAPI.getResourceTempUrl(resourceId, message);
  return extractImagesFromSegmentsAsync(referencedMessage.segments as MessageSegment[], getResourceUrl);
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
  const getResourceUrl = (resourceId: string) => messageAPI.getResourceTempUrl(resourceId, message);

  // Extract images from current message (resolve resource_id via get_resource_temp_url when needed)
  if (message.segments && message.segments.length > 0) {
    const currentImages = await extractImagesFromSegmentsAsync(
      message.segments as MessageSegment[],
      getResourceUrl,
    );
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
