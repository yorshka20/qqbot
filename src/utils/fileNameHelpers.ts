/**
 * Filename helpers for downloads and dedup (e.g. extension from URL, unique names, hash for dedup).
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';

/**
 * Generate a short hash from string (for short deterministic filename, e.g. sticker dedup).
 */
export function hashForFilename(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12);
}

/**
 * Get file extension from URL path (respect source suffix). Returns e.g. ".jpg" or "".
 */
export function getExtensionFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() ?? '';
    const e = extname(base);
    return e && /^\.\w+$/.test(e) ? e : '';
  } catch {
    return '';
  }
}

/** Default extension by kind when URL has no suffix (avoid .bin for preview). */
export const DEFAULT_EXT_BY_KIND: Record<'image' | 'sticker' | 'video' | 'file', string> = {
  image: '.png',
  sticker: '.gif',
  video: '.mp4',
  file: '.dat',
};

export function getDefaultExtension(kind: 'image' | 'sticker' | 'video' | 'file'): string {
  return DEFAULT_EXT_BY_KIND[kind] ?? '.dat';
}

/**
 * Generate a short unique filename (no dedup). ext should include dot, e.g. ".jpg" or "".
 */
export function uniqueFilename(prefix: string, ext: string): string {
  const ts = Date.now();
  const r = Math.random().toString(36).slice(2, 8);
  const dotExt = ext?.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `${prefix}_${ts}_${r}${dotExt}`;
}
