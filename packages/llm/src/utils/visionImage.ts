import type { VisionImage } from '../capabilities/types';

/**
 * Convert VisionImage to the URL string an OpenAI-style `image_url` content part carries:
 * an inline `data:` URL for base64 payloads, otherwise the remote URL.
 *
 * base64 wins over url because `normalizeVisionImages` downloads every image up front so
 * the model is never handed a URL it has to fetch itself (protocol temp URLs expire, and
 * private-network hosts are unreachable from the provider side).
 */
export function visionImageToDataUrl(image: VisionImage): string {
  if (image.base64) {
    return `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`;
  }
  if (image.url) {
    return image.url;
  }
  throw new Error('Invalid image format. Images should be normalized by VisionService (url or base64 required).');
}
