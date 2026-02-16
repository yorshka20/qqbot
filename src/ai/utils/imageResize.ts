// Image resize utility for img2img - resize to exact dimensions and return raw base64

import { logger } from '@/utils/logger';
import sharp from 'sharp';

/** Max dimension (width or height) for I2V input, in pixels */
const I2V_MAX_DIMENSION = 1024;

/** Max file size for I2V input, in bytes (500 KB) */
const I2V_MAX_BYTES = 500 * 1024;

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

/**
 * Prepare image for I2V: scale proportionally so resolution does not exceed 1k (max dimension 1024)
 * and file size is under 500 KB. Aspect ratio is preserved. Returns original buffer if already within limits.
 *
 * @param imageBuffer - Raw image buffer (any format supported by sharp)
 * @returns Buffer (PNG or JPEG) meeting size and resolution limits
 */
export async function prepareImageForI2v(imageBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const maxDim = Math.max(width, height);

  if (maxDim <= I2V_MAX_DIMENSION && imageBuffer.length <= I2V_MAX_BYTES) {
    logger.debug(`[imageResize] I2V image within limits: ${width}x${height}, ${imageBuffer.length} bytes`);
    return imageBuffer;
  }

  // Scale down proportionally so longest side is at most I2V_MAX_DIMENSION (fit: 'inside' keeps ratio)
  let pipeline = sharp(imageBuffer).resize(I2V_MAX_DIMENSION, I2V_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  let out = await pipeline.png().toBuffer();

  if (out.length <= I2V_MAX_BYTES) {
    const m = await sharp(out).metadata();
    logger.info(`[imageResize] I2V image scaled to ${m.width}x${m.height}, ${out.length} bytes (PNG)`);
    return out;
  }

  // Still over 500 KB: re-encode as JPEG and optionally scale down further until under limit
  const qualities = [90, 85, 80, 75, 70, 65, 60] as const;
  for (const q of qualities) {
    out = await sharp(imageBuffer)
      .resize(I2V_MAX_DIMENSION, I2V_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer();
    if (out.length <= I2V_MAX_BYTES) {
      const m = await sharp(out).metadata();
      logger.info(`[imageResize] I2V image scaled to ${m.width}x${m.height}, ${out.length} bytes (JPEG q=${q})`);
      return out;
    }
  }

  // Reduce resolution proportionally until under 500 KB
  for (let maxSide = 900; maxSide >= 256; maxSide -= 128) {
    out = await sharp(imageBuffer)
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    if (out.length <= I2V_MAX_BYTES) {
      const m = await sharp(out).metadata();
      logger.info(`[imageResize] I2V image scaled to ${m.width}x${m.height}, ${out.length} bytes (JPEG, max ${maxSide})`);
      return out;
    }
  }

  // Last resort: 256px max, low quality
  out = await sharp(imageBuffer)
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  logger.info(`[imageResize] I2V image scaled to fit 256px, ${out.length} bytes`);
  return out;
}
