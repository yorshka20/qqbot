// Image resize utility for img2img - resize to exact dimensions and return raw base64

import { logger } from '@/utils/logger';
import sharp from 'sharp';

/**
 * Resize image to exact target dimensions and return raw base64 (no data URL prefix).
 * Uses fit: 'fill' to match exact width/height; required by APIs like NovelAI img2img.
 *
 * @param imageBufferOrBase64 - Image as Buffer or raw base64 string
 * @param width - Target width in pixels
 * @param height - Target height in pixels
 * @returns Raw base64 encoded string (PNG)
 */
export async function resizeImageToBase64(
  imageBufferOrBase64: Buffer | string,
  width: number,
  height: number,
): Promise<string> {
  const buffer = typeof imageBufferOrBase64 === 'string' ? Buffer.from(imageBufferOrBase64, 'base64') : imageBufferOrBase64;

  const resized = await sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();

  const base64 = resized.toString('base64');
  logger.debug(`[imageResize] Resized to ${width}x${height}, output ${base64.length} chars base64`);
  return base64;
}
