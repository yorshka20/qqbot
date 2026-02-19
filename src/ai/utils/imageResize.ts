// Image resize utility for img2img - resize to exact dimensions and return raw base64

import { logger } from '@/utils/logger';
import sharp from 'sharp';

/** Max dimension for I2V input: fit within 480×832 / 832×480 (scale proportionally, max 832 per side) */
const I2V_MAX_DIMENSION = 832;

/** Max file size for I2V input, in bytes (500 KB) */
export const I2V_MAX_BYTES = 500 * 1024;

/** Max file size for vision input, in bytes (500 KB) - same as I2V for API limits */
export const VISION_MAX_BYTES = 500 * 1024;

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
 * Shared: compress image buffer so size does not exceed maxBytes, with optional max dimension.
 * Preserves aspect ratio. Used by I2V and vision flows.
 *
 * @param buffer - Raw image buffer
 * @param maxBytes - Maximum size in bytes (e.g. 500 * 1024)
 * @param maxDimension - Maximum width/height in pixels (fit: 'inside')
 * @param logPrefix - Optional prefix for log messages (e.g. 'I2V' or 'Vision')
 * @returns { buffer, mimeType }
 */
async function compressBufferToMaxBytes(
  buffer: Buffer,
  maxBytes: number,
  maxDimension: number,
  logPrefix: string = 'image',
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (buffer.length <= maxBytes) {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    // Only skip resize when both file size and dimensions are within limits
    if (w <= maxDimension && h <= maxDimension) {
      const format = meta.format;
      const mimeType =
        format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : format === 'gif' ? 'image/gif' : 'image/jpeg';
      return { buffer, mimeType };
    }
  }

  const resizeOpt = () => ({ fit: 'inside' as const, withoutEnlargement: true });

  // Try PNG at max dimension
  let out = await sharp(buffer).resize(maxDimension, maxDimension, resizeOpt()).png().toBuffer();
  if (out.length <= maxBytes) {
    logger.debug(`[imageResize] ${logPrefix} compressed to ${out.length} bytes (PNG)`);
    return { buffer: out, mimeType: 'image/png' };
  }

  // JPEG with decreasing quality
  const qualities = [90, 85, 80, 75, 70, 65, 60] as const;
  for (const q of qualities) {
    out = await sharp(buffer).resize(maxDimension, maxDimension, resizeOpt()).jpeg({ quality: q }).toBuffer();
    if (out.length <= maxBytes) {
      logger.debug(`[imageResize] ${logPrefix} compressed to ${out.length} bytes (JPEG q=${q})`);
      return { buffer: out, mimeType: 'image/jpeg' };
    }
  }

  // Reduce resolution (step size depends on maxDimension for I2V vs vision)
  const step = maxDimension <= 1024 ? 128 : 256;
  for (let maxSide = maxDimension - step; maxSide >= 256; maxSide -= step) {
    out = await sharp(buffer).resize(maxSide, maxSide, resizeOpt()).jpeg({ quality: 85 }).toBuffer();
    if (out.length <= maxBytes) {
      logger.debug(`[imageResize] ${logPrefix} compressed to ${out.length} bytes (JPEG max ${maxSide})`);
      return { buffer: out, mimeType: 'image/jpeg' };
    }
  }

  const lastQuality = maxDimension <= 1024 ? 70 : 75;
  out = await sharp(buffer).resize(256, 256, resizeOpt()).jpeg({ quality: lastQuality }).toBuffer();
  logger.debug(`[imageResize] ${logPrefix} compressed to ${out.length} bytes (min size)`);
  return { buffer: out, mimeType: 'image/jpeg' };
}

/**
 * Prepare image for I2V: scale proportionally to fit within 480×832 / 832×480 (max dimension 832)
 * and file size under 500 KB. Aspect ratio is preserved. Returns original buffer if already within limits.
 *
 * @param imageBuffer - Raw image buffer (any format supported by sharp)
 * @returns Buffer (PNG or JPEG) meeting size and resolution limits
 */
export async function prepareImageForI2v(imageBuffer: Buffer): Promise<Buffer> {
  const { buffer } = await compressBufferToMaxBytes(
    imageBuffer,
    I2V_MAX_BYTES,
    I2V_MAX_DIMENSION,
    'I2V',
  );
  return buffer;
}

/** Max dimension when scaling down for vision (preserve aspect ratio) */
const VISION_MAX_DIMENSION = 2048;

/**
 * Compress image so decoded size does not exceed maxBytes (e.g. 500 KB for vision APIs).
 * Preserves aspect ratio. Returns base64 and mimeType (image/jpeg or image/png).
 * Reuses same logic as prepareImageForI2v with configurable maxBytes and larger max dimension.
 *
 * @param bufferOrBase64 - Image as Buffer or raw base64 string
 * @param maxBytes - Maximum size in bytes (default 500 * 1024)
 * @returns { base64, mimeType }
 */
export async function compressImageToMaxBytes(
  bufferOrBase64: Buffer | string,
  maxBytes: number = VISION_MAX_BYTES,
): Promise<{ base64: string; mimeType: string }> {
  const buffer = typeof bufferOrBase64 === 'string' ? Buffer.from(bufferOrBase64, 'base64') : bufferOrBase64;
  const { buffer: out, mimeType } = await compressBufferToMaxBytes(
    buffer,
    maxBytes,
    VISION_MAX_DIMENSION,
    'Vision',
  );
  return { base64: out.toString('base64'), mimeType };
}
