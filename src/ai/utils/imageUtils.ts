// Image utilities for converting message segments to VisionImage format

import type { MessageSegment } from '@/message/types';
import type { VisionImage } from '../capabilities/types';

/**
 * Extract images from message segments
 */
export function extractImagesFromSegments(segments: MessageSegment[]): VisionImage[] {
  const images: VisionImage[] = [];

  for (const segment of segments) {
    if (segment.type === 'image') {
      const imageData = segment.data;
      const visionImage: VisionImage = {};

      // Handle Milky protocol uri field
      if (imageData.uri) {
        if (imageData.uri.startsWith('base64://')) {
          // Extract base64 data from base64:// URI
          visionImage.base64 = imageData.uri.substring(9); // Remove 'base64://' prefix
        } else if (imageData.uri.startsWith('http://') || imageData.uri.startsWith('https://')) {
          visionImage.url = imageData.uri;
        } else if (imageData.uri.startsWith('file://')) {
          visionImage.file = imageData.uri.substring(7); // Remove 'file://' prefix
        } else {
          // Fallback: treat as URL
          visionImage.url = imageData.uri;
        }
      }

      // Legacy field support for backward compatibility
      if (imageData.url) {
        visionImage.url = imageData.url;
      }

      if (imageData.file) {
        visionImage.file = imageData.file;
      }

      if (imageData.data) {
        // Base64 encoded image data
        visionImage.base64 = imageData.data;
      }

      // Try to infer MIME type from URL or file extension
      if (imageData.url) {
        const urlLower = imageData.url.toLowerCase();
        if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
          visionImage.mimeType = 'image/jpeg';
        } else if (urlLower.includes('.png')) {
          visionImage.mimeType = 'image/png';
        } else if (urlLower.includes('.gif')) {
          visionImage.mimeType = 'image/gif';
        } else if (urlLower.includes('.webp')) {
          visionImage.mimeType = 'image/webp';
        }
      } else if (imageData.file) {
        const fileLower = imageData.file.toLowerCase();
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

      images.push(visionImage);
    }
  }

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
