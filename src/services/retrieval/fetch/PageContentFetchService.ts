// Full-page fetch for top search results: extract article body or video description.

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { HttpClient } from '@/api/http/HttpClient';
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

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Built-in video host -> description selector. B站 and similar. */
const DEFAULT_VIDEO_DESCRIPTION_SELECTORS: Record<string, string> = {
  'www.bilibili.com': '.desc, .video-desc, [itemprop="description"]',
  'bilibili.com': '.desc, .video-desc, [itemprop="description"]',
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

function isVideoUrl(url: string): boolean {
  return VIDEO_URL_PATTERNS.some((p) => p.test(url));
}

function shouldSkipFetch(url: string, skipPatterns?: string[]): boolean {
  const patterns = skipPatterns?.length ? skipPatterns.map((s) => new RegExp(s, 'i')) : DEFAULT_SKIP_PATTERNS;
  return patterns.some((p) => p.test(url));
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
        return el.textContent.replace(/\s+/g, ' ').trim();
      }
    } catch {
      // ignore invalid selector
    }
  }
  return '';
}

/**
 * Extract main article content using Readability; fallback to body text.
 */
function extractArticleContent(html: string, url: string): { title: string; textContent: string } {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  try {
    const reader = new Readability(doc);
    const article = reader.parse();
    if (article?.textContent) {
      return { title: article.title || '', textContent: article.textContent };
    }
  } catch (err) {
    logger.debug(
      `[PageContentFetchService] Readability parse failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Fallback: strip script/style, use body text
  const clone = doc.cloneNode(true) as Document;
  for (const tag of ['script', 'style', 'nav', 'header', 'footer']) {
    for (const el of clone.querySelectorAll(tag)) {
      el.remove();
    }
  }
  const body = clone.body;
  const text = body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const title = clone.querySelector('title')?.textContent?.trim() ?? '';
  return { title, textContent: text };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '…';
}

/**
 * Normalize fetched text: collapse runs of whitespace and empty lines for cleaner context.
 */
function cleanFetchedText(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface PageContentFetchServiceOptions {
  config: SearchFetchConfig | null | undefined;
}

/**
 * Fetches full page content for top search results after filter-refine.
 * For article URLs: Readability + jsdom; for video URLs: description-only extraction.
 */
export class PageContentFetchService {
  private readonly fetchEnabled: boolean;
  private readonly maxUrlsToFetch: number;
  private readonly maxCharsPerPage: number;
  private readonly maxCharsPerVideoDescription: number;
  private readonly fetchTimeoutMs: number;
  private readonly skipFetchPatterns: string[] | undefined;
  private readonly videoSelectors: Record<string, string>;
  private readonly httpClient: HttpClient;

  constructor(options: PageContentFetchServiceOptions) {
    const cfg = options.config;
    this.fetchEnabled = cfg?.fetchFullPage === true;
    this.maxUrlsToFetch = Math.min(5, Math.max(1, cfg?.maxUrlsToFetch ?? 3));
    this.maxCharsPerPage = Math.max(500, cfg?.maxCharsPerPage ?? 6000);
    this.maxCharsPerVideoDescription = Math.max(200, cfg?.maxCharsPerVideoDescription ?? 2000);
    this.fetchTimeoutMs = Math.max(2000, cfg?.fetchTimeoutMs ?? 10000);
    this.skipFetchPatterns = cfg?.skipFetchPatterns;
    this.videoSelectors = { ...DEFAULT_VIDEO_DESCRIPTION_SELECTORS, ...cfg?.videoDescriptionSelectors };
    this.httpClient = new HttpClient({
      defaultTimeout: this.fetchTimeoutMs,
      defaultHeaders: { 'User-Agent': DEFAULT_USER_AGENT },
    });
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
    let html: string;
    try {
      const res = await this.httpClient.get<string>(url, {
        timeout: this.fetchTimeoutMs,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      if (typeof res !== 'string') {
        logger.debug(`[PageContentFetchService] Non-HTML response for ${url}`);
        return this.fallbackEntry(entry);
      }
      html = res;
    } catch (err) {
      logger.warn(
        `[PageContentFetchService] Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallbackEntry(entry);
    }
    if (isVideoUrl(url)) {
      const desc = extractVideoDescription(html, url, this.videoSelectors);
      if (desc) {
        logger.debug(`[PageContentFetchService] Video description extracted for ${url}`);
        return {
          url,
          title,
          text: truncate(cleanFetchedText(desc), this.maxCharsPerVideoDescription),
        };
      }
      logger.debug(`[PageContentFetchService] Video description empty for ${url}, using snippet`);
      return this.fallbackEntry(entry);
    }
    const { textContent } = extractArticleContent(html, url);
    if (!textContent.trim()) {
      return this.fallbackEntry(entry);
    }
    return {
      url,
      title,
      text: truncate(cleanFetchedText(textContent), this.maxCharsPerPage),
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
      text: cleanFetchedText(snippet),
    };
  }
}
