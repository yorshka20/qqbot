// WBI signature utility for bilibili API anti-scraping
// Ported from https://github.com/yorshka20/JKVideo/blob/master/utils/wbi.ts

import { createHash } from 'node:crypto';
import { logger } from '@/utils/logger';

/**
 * Fixed permutation table for generating the mixin key.
 * This is a well-known constant used by bilibili's WBI signing algorithm.
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

/** Characters to strip from parameter values before signing */
const FILTER_CHARS = /[!'()*]/g;

interface WbiCache {
  imgKey: string;
  subKey: string;
  mixinKey: string;
  timestamp: number;
}

let wbiCache: WbiCache | null = null;
const WBI_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

const WBI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com',
};

/**
 * Generate the mixin key from img_key + sub_key using the permutation table.
 */
function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += orig[MIXIN_KEY_ENC_TAB[i]];
  }
  return result;
}

/**
 * Extract the key portion from a WBI URL.
 * e.g. "https://i0.hdslb.com/bfs/wbi/abc123.png" -> "abc123"
 */
function extractKeyFromUrl(url: string): string {
  const filename = url.split('/').pop() || '';
  return filename.split('.')[0];
}

/**
 * Fetch fresh WBI keys from bilibili's nav endpoint.
 */
async function fetchWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: WBI_HEADERS,
  });

  const json = (await response.json()) as { code: number; data: { wbi_img: { img_url: string; sub_url: string } } };

  if (!json.data?.wbi_img) {
    throw new Error('Failed to fetch WBI keys from nav endpoint');
  }

  return {
    imgKey: extractKeyFromUrl(json.data.wbi_img.img_url),
    subKey: extractKeyFromUrl(json.data.wbi_img.sub_url),
  };
}

/**
 * Get the current mixin key, fetching fresh WBI keys if the cache has expired.
 */
async function getMixinKeyWithCache(): Promise<string> {
  const now = Date.now();
  if (wbiCache && now - wbiCache.timestamp < WBI_CACHE_TTL) {
    return wbiCache.mixinKey;
  }

  logger.debug('[WBI] Fetching fresh WBI keys');
  const { imgKey, subKey } = await fetchWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);

  wbiCache = { imgKey, subKey, mixinKey, timestamp: now };
  logger.debug('[WBI] WBI keys cached successfully');

  return mixinKey;
}

/**
 * Sign request parameters using bilibili's WBI algorithm.
 *
 * @param params - The query parameters to sign
 * @returns The signed query string (including wts and w_rid)
 */
export async function signWbiParams(params: Record<string, string | number>): Promise<string> {
  const mixinKey = await getMixinKeyWithCache();

  // Add timestamp
  const wts = Math.floor(Date.now() / 1000);
  const allParams: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    wts: String(wts),
  };

  // Sort by key
  const sortedKeys = Object.keys(allParams).sort();

  // Build query string with filtered values
  const queryParts: string[] = [];
  for (const key of sortedKeys) {
    const value = allParams[key].replace(FILTER_CHARS, '');
    queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  const queryString = queryParts.join('&');

  // MD5 hash (query_string + mixin_key)
  const wRid = createHash('md5')
    .update(queryString + mixinKey)
    .digest('hex');

  return `${queryString}&w_rid=${wRid}`;
}

/** Exported for callers that need to bust the WBI cache on 412 errors. */
export function clearWbiCache(): void {
  wbiCache = null;
  logger.debug('[WBI] Cache cleared');
}
