// Full-page fetch for top search results: extract article body or video description.
// Purpose: provide clean, normalized text for AI consumption (source + main content).

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { SearchFetchConfig } from '@/core/config/types/mcp';
import { logger } from '@/utils/logger';
import type { FetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';

export interface FetchEntry {
  url: string;
  title: string;
  text: string;
}

export interface FetchPageOptions {
  url: string;
  title: string;
  snippet?: string;
}

/** Payload passed when a URL is about to be fetched (for progress UX). */
export interface FetchingUrlPayload {
  title: string;
  url: string;
  index: number;
}

/** Crawler-style headers: request HTML and prefer Chinese then English. */
const DEFAULT_PAGE_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** Built-in video host -> description selector. B站: main text in #v_desc .desc-info-text. */
const DEFAULT_VIDEO_DESCRIPTION_SELECTORS: Record<string, string> = {
  'www.bilibili.com':
    '#v_desc .desc-info-text, .video-desc-container .desc-info-text, .desc, .video-desc, [itemprop="description"]',
  'bilibili.com':
    '#v_desc .desc-info-text, .video-desc-container .desc-info-text, .desc, .video-desc, [itemprop="description"]',
};

/** URL patterns that match video pages (description-only extraction). */
const VIDEO_URL_PATTERNS = [/bilibili\.com\/video\//i, /bilibili\.com\/BV[\w]+/i];

/** URL patterns to skip fetch entirely (e.g. PDF, binary). */
const DEFAULT_SKIP_PATTERNS = [/\.pdf$/i, /\.zip$/i, /\.rar$/i, /\.exe$/i, /file:\/\//i];

function getHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Parse charset from Content-Type (e.g. "text/html; charset=gbk" -> "gbk"). Returns lowercase or null. */
function parseCharsetFromContentType(contentType: string): string | null {
  const m = contentType.match(/charset\s*=\s*([^;\s]+)/i);
  if (!m) {
    return null;
  }
  return m[1].replace(/['"]/g, '').trim().toLowerCase();
}

/**
 * Fetch HTML for crawler: Accept text/html, respect Content-Type, decode with charset.
 * Returns decoded HTML string or null on non-HTML, error, or timeout.
 */
export async function fetchHtmlForCrawler(
  url: string,
  options: { timeoutMs: number; headers: Record<string, string> },
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: options.headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.debug(`[PageContentFetchService] Fetch ${url} status ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || /^image\//i.test(contentType)) {
      logger.debug(`[PageContentFetchService] Skip non-HTML content-type for ${url}: ${contentType}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const charset = parseCharsetFromContentType(contentType);
    const encoding = charset === 'utf-8' || charset === 'utf8' || !charset ? 'utf-8' : charset;

    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        logger.warn(`[PageContentFetchService] Fetch timeout for ${url}`);
      } else {
        logger.warn(`[PageContentFetchService] Fetch failed for ${url}: ${err.message}`);
      }
    }
    return null;
  }
}

/** Format extracted content for AI: source line + body so model knows provenance. */
function formatForAiConsumption(entry: { url: string; title: string; text: string }): string {
  const sourceLine = `Source: ${entry.title || 'Untitled'} | ${entry.url}`;
  const body = (entry.text || '').trim();
  return body ? `${sourceLine}\n\n${body}` : sourceLine;
}

function isVideoUrl(url: string): boolean {
  return VIDEO_URL_PATTERNS.some((p) => p.test(url));
}

function shouldSkipFetch(url: string, skipPatterns?: string[]): boolean {
  const patterns = skipPatterns?.length ? skipPatterns.map((s) => new RegExp(s, 'i')) : DEFAULT_SKIP_PATTERNS;
  return patterns.some((p) => p.test(url));
}

/** Tags to remove from document before extracting text (boilerplate/noise). */
const BOILERPLATE_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'svg',
  'canvas',
  'object',
  'embed',
  'template',
];

/** Selectors for common ad/sidebar/noise elements (remove before fallback extraction). */
const BOILERPLATE_SELECTORS = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.ad',
  '.ads',
  '.advertisement',
  '.sidebar',
  '.side-bar',
  '.menu',
  '.cookie-banner',
  '.consent-banner',
  '#sidebar',
  '#ad',
  '#ads',
];

/**
 * Remove boilerplate nodes from document so body text is cleaner. Mutates doc.
 */
function stripBoilerplate(doc: Document): void {
  for (const tag of BOILERPLATE_TAGS) {
    const list = doc.querySelectorAll(tag);
    for (const el of Array.from(list)) {
      el.remove();
    }
  }
  for (const sel of BOILERPLATE_SELECTORS) {
    try {
      const list = doc.querySelectorAll(sel);
      for (const el of Array.from(list)) {
        el.remove();
      }
    } catch {
      // ignore invalid selector
    }
  }
}

/**
 * Extract video page description from HTML using host-based selector.
 * Returns trimmed text or empty string.
 */
function extractVideoDescription(html: string, url: string, selectors: Record<string, string>): string {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const host = getHost(url);
  const selector = selectors[host] || selectors[`www.${host}`];
  if (!selector) {
    return '';
  }
  const parts = selector.split(',').map((s) => s.trim());
  for (const sel of parts) {
    try {
      const el = doc.querySelector(sel);
      if (el?.textContent) {
        return normalizeExtractedText(el.textContent);
      }
    } catch {
      // ignore invalid selector
    }
  }
  return '';
}

/**
 * Extract main article content: Readability on a clone (non-mutating), then fallback with stripped body.
 */
export function extractArticleContent(html: string, url: string): { title: string; textContent: string } {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Run Readability on a clone so we keep original doc for fallback
  const clone = doc.cloneNode(true) as Document;
  try {
    const reader = new Readability(clone);
    const article = reader.parse();
    if (article?.textContent?.trim()) {
      return {
        title: (article.title || '').trim(),
        textContent: normalizeExtractedText(article.textContent),
      };
    }
  } catch (err) {
    logger.debug(
      `[PageContentFetchService] Readability parse failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: strip boilerplate from original doc, then take body text
  stripBoilerplate(doc);
  const body = doc.body;
  const raw = body?.textContent?.trim() ?? '';
  const title = doc.querySelector('title')?.textContent?.trim() ?? '';
  return {
    title,
    textContent: raw ? normalizeExtractedText(raw) : '',
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Strip control and zero-width/invisible characters from string (avoids control chars in regex source).
 */
function stripControlAndInvisible(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      continue; // C0 controls except tab, LF, CR
    }
    if (code >= 0x7f && code <= 0x9f) {
      continue; // C1 controls
    }
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060 || code === 0xfeff) {
      continue; // zero-width / BOM
    }
    out += String.fromCodePoint(code);
    if (code > 0xffff) {
      i++;
    }
  }
  return out;
}

/**
 * Normalize extracted HTML text: unicode NFKC, strip control/invisible chars, collapse whitespace and newlines.
 */
function normalizeExtractedText(text: string): string {
  if (!text || text.length === 0) {
    return '';
  }
  // Unicode normalization (e.g. fullwidth to halfwidth where appropriate)
  let out = text.normalize('NFKC');
  out = stripControlAndInvisible(out);
  // Collapse runs of whitespace to single space, and runs of newlines to at most 2
  out = out.replace(/\r\n|\r/g, '\n').replace(/\n{3,}/g, '\n\n');
  out = out.replace(/[ \t]+/g, ' ');
  // Trim each line and drop empty lines, then join with single newline
  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.join('\n');
}

/**
 * Clean fetched text for final output: apply normalization and collapse empty lines.
 * Kept for backward compatibility with call sites that expect "cleanFetchedText".
 */
function cleanFetchedText(text: string): string {
  return normalizeExtractedText(text);
}

export interface PageContentFetchServiceOptions {
  config: SearchFetchConfig | null | undefined;
}

/**
 * Fetches full page content for top search results after filter-refine.
 * Crawler-oriented: Accept text/html, Accept-Language, charset-aware decode.
 * Output is formatted for AI consumption (source line + normalized main content).
 */
export class PageContentFetchService {
  private readonly fetchEnabled: boolean;
  private readonly maxUrlsToFetch: number;
  private readonly maxCharsPerPage: number;
  private readonly maxCharsPerVideoDescription: number;
  private readonly fetchTimeoutMs: number;
  private readonly skipFetchPatterns: string[] | undefined;
  private readonly videoSelectors: Record<string, string>;
  private readonly pageFetchHeaders: Record<string, string>;

  constructor(options: PageContentFetchServiceOptions) {
    const cfg = options.config;
    this.fetchEnabled = cfg?.fetchFullPage === true;
    this.maxUrlsToFetch = Math.min(5, Math.max(1, cfg?.maxUrlsToFetch ?? 3));
    this.maxCharsPerPage = Math.max(500, cfg?.maxCharsPerPage ?? 6000);
    this.maxCharsPerVideoDescription = Math.max(200, cfg?.maxCharsPerVideoDescription ?? 2000);
    this.fetchTimeoutMs = Math.max(2000, cfg?.fetchTimeoutMs ?? 10000);
    this.skipFetchPatterns = cfg?.skipFetchPatterns;
    this.videoSelectors = { ...DEFAULT_VIDEO_DESCRIPTION_SELECTORS, ...cfg?.videoDescriptionSelectors };
    this.pageFetchHeaders = { ...DEFAULT_PAGE_FETCH_HEADERS };
  }

  isEnabled(): boolean {
    return this.fetchEnabled;
  }

  /**
   * Fetch multiple pages in parallel. Calls notifier.onFetchingUrls once with all titles before fetching.
   * Returns only successful entries; failed or skipped URLs are omitted.
   */
  async fetchPages(entries: FetchPageOptions[], notifier?: FetchProgressNotifier): Promise<FetchEntry[]> {
    if (!this.fetchEnabled || entries.length === 0) {
      return [];
    }
    const toFetch = entries.slice(0, this.maxUrlsToFetch);
    const titles = toFetch.map((e) => e.title || '无标题');
    notifier?.onFetchingUrls(titles);
    const results = await Promise.allSettled(toFetch.map((entry) => this.fetchOne(entry)));
    const out: FetchEntry[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        out.push(r.value);
      }
    }
    if (out.length > 0) {
      logger.info(
        `[PageContentFetchService] Fetched ${out.length} pages, total ${out.reduce((s, e) => s + e.text.length, 0)} chars`,
      );
    }
    return out;
  }

  private async fetchOne(entry: FetchPageOptions): Promise<FetchEntry | null> {
    const { url, title } = entry;
    if (shouldSkipFetch(url, this.skipFetchPatterns)) {
      logger.debug(`[PageContentFetchService] Skip fetch (pattern): ${url}`);
      return null;
    }

    const html = await fetchHtmlForCrawler(url, {
      timeoutMs: this.fetchTimeoutMs,
      headers: this.pageFetchHeaders,
    });
    if (html === null) {
      return this.fallbackEntry(entry);
    }

    if (isVideoUrl(url)) {
      const desc = extractVideoDescription(html, url, this.videoSelectors);
      if (desc) {
        logger.debug(`[PageContentFetchService] Video description extracted for ${url}`);
        const body = truncate(cleanFetchedText(desc), this.maxCharsPerVideoDescription);
        return {
          url,
          title,
          text: formatForAiConsumption({ url, title, text: body }),
        };
      }
      logger.debug(`[PageContentFetchService] Video description empty for ${url}, using snippet`);
      return this.fallbackEntry(entry);
    }

    const { textContent } = extractArticleContent(html, url);
    if (!textContent.trim()) {
      return this.fallbackEntry(entry);
    }
    const body = truncate(cleanFetchedText(textContent), this.maxCharsPerPage);
    return {
      url,
      title,
      text: formatForAiConsumption({ url, title, text: body }),
    };
  }

  private fallbackEntry(entry: FetchPageOptions): FetchEntry | null {
    const snippet = (entry.snippet || '').trim();
    if (!snippet) {
      return null;
    }
    return {
      url: entry.url,
      title: entry.title,
      text: formatForAiConsumption({
        url: entry.url,
        title: entry.title,
        text: cleanFetchedText(snippet),
      }),
    };
  }
}
