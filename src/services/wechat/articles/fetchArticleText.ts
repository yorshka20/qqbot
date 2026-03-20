// Shared utility: fetch full-text from a WeChat article URL (best-effort, WeChat mobile UA)

import { logger } from '@/utils/logger';

const JS_CONTENT_RE = /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i;

/**
 * Strip HTML tags and entities from a string, returning clean plain text.
 * Safe to call on text that is already plain — it will pass through unchanged.
 */
export function stripHtml(html: string): string {
  return html
    // Block-level tags → newline (preserve paragraph structure)
    .replace(/<\s*\/?\s*(?:p|div|br|section|article|h[1-6]|ul|ol|li|blockquote|pre|hr|tr|table)[\s>/]/gi, '\n')
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch and clean the full text of a WeChat article.
 * Returns the cleaned text on success, or `fallback` if fetching fails or content is too thin.
 */
export async function fetchArticleText(url: string, fallback: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      logger.warn(`[fetchArticleText] HTTP ${resp.status} for ${url}`);
      return fallback;
    }
    const html = await resp.text();
    const bodyMatch = html.match(JS_CONTENT_RE);
    const rawText = bodyMatch?.[1] ?? '';
    const text = stripHtml(rawText);
    if (text.length > 100) {
      logger.info(`[fetchArticleText] Fetched: "${fallback}" — ${text.length} chars`);
      return text;
    }
    // Likely a verification/login page — fall back
    logger.warn(`[fetchArticleText] Thin content (${text.length} chars), using fallback`);
    return fallback;
  } catch (err) {
    logger.warn(`[fetchArticleText] Error for ${url}:`, err);
    return fallback;
  }
}
