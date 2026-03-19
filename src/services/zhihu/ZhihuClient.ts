// ZhihuClient — HTTP client for Zhihu private API
// Handles cookie management, rate limiting, and retry logic

import { logger } from '@/utils/logger';
import type { ZhihuAnswer, ZhihuArticle, ZhihuFeedItem, ZhihuMomentsResponse, ZhihuUser } from './types';

export interface ZhihuClientConfig {
  cookie: string;
  requestIntervalMs?: number;
  maxRetries?: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class ZhihuClient {
  private cookie: string;
  private userAgent = DEFAULT_USER_AGENT;
  private requestIntervalMs: number;
  private maxRetries: number;
  private lastRequestTime = 0;
  private failCount = 0;
  private cookieValid = true;

  constructor(config: ZhihuClientConfig) {
    this.cookie = config.cookie;
    this.requestIntervalMs = config.requestIntervalMs ?? 2000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  // ──────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────

  /** Fetch moments (关注动态) feed. */
  async fetchMoments(limit = 20, cursor?: string): Promise<ZhihuMomentsResponse> {
    let url = `https://www.zhihu.com/api/v3/moments?desktop=true&limit=${limit}`;
    if (cursor) {
      url += `&after_id=${cursor}`;
    }
    return this.request<ZhihuMomentsResponse>(url);
  }

  /** Fetch all moments since a given timestamp, with pagination. */
  async fetchAllMomentsSince(sinceTimestamp: number, maxPages = 5): Promise<ZhihuFeedItem[]> {
    const allItems: ZhihuFeedItem[] = [];
    let cursor: string | undefined;
    let page = 0;

    while (page < maxPages) {
      const response = await this.fetchMoments(20, cursor);
      if (!response.data || response.data.length === 0) break;

      allItems.push(...response.data);
      page++;

      // Check if we've reached items older than sinceTimestamp
      const oldestItem = response.data[response.data.length - 1];
      if (oldestItem && oldestItem.created_time <= sinceTimestamp) break;
      if (response.paging.is_end) break;

      // Extract cursor from next URL
      cursor = this.extractCursorFromUrl(response.paging.next);
      if (!cursor) break;
    }

    // Filter out items older than sinceTimestamp
    return allItems.filter((item) => item.created_time > sinceTimestamp);
  }

  /** Fetch a single answer's full content. Does NOT invalidate cookie on 403. */
  async fetchAnswerContent(answerId: number): Promise<ZhihuAnswer> {
    return this.requestContent<ZhihuAnswer>(`https://www.zhihu.com/api/v4/answers/${answerId}?include=content`);
  }

  /** Fetch a single article's full content. Does NOT invalidate cookie on 403. */
  async fetchArticleContent(articleId: number): Promise<ZhihuArticle> {
    return this.requestContent<ZhihuArticle>(`https://www.zhihu.com/api/v4/articles/${articleId}`);
  }

  /** Fetch current user info (used for cookie validity check). */
  async fetchMe(): Promise<ZhihuUser> {
    return this.request<ZhihuUser>('https://www.zhihu.com/api/v4/me');
  }

  /** Check if the current cookie is valid. */
  async checkCookieValidity(): Promise<boolean> {
    try {
      const me = await this.fetchMe();
      if (me?.id) {
        this.cookieValid = true;
        this.failCount = 0;
        logger.info(`[ZhihuClient] Cookie valid, logged in as: ${me.name}`);
        return true;
      }
    } catch {
      // Falls through to invalid
    }
    this.cookieValid = false;
    logger.warn('[ZhihuClient] Cookie is invalid or expired');
    return false;
  }

  /** Update cookie (hot reload). */
  updateCookie(newCookie: string): void {
    this.cookie = newCookie;
    this.failCount = 0;
    this.cookieValid = true;
    logger.info('[ZhihuClient] Cookie updated');
  }

  /** Whether cookie is considered valid. */
  isCookieValid(): boolean {
    return this.cookieValid;
  }

  /** Current consecutive failure count. */
  getFailCount(): number {
    return this.failCount;
  }

  // ──────────────────────────────────────────────────
  // Content formatting
  // ──────────────────────────────────────────────────

  /**
   * Convert Zhihu HTML content to readable text with images preserved.
   * Keeps <img> src URLs inline as markdown-style image references.
   * Falls back to plain text if formatting fails.
   */
  static formatContent(html: string | undefined): string {
    if (!html || typeof html !== 'string') return '';

    try {
      let text = html;

      // Preserve images: convert <img> to markdown-style ![](url)
      // Zhihu images use data-original or data-actualsrc for full-res URLs
      text = text.replace(/<img[^>]*?(?:data-original|data-actualsrc)="([^"]+)"[^>]*>/gi, (_, url: string) => {
        return `\n![](${url})\n`;
      });
      // Fallback: <img> with only src
      text = text.replace(/<img[^>]*?src="([^"]+)"[^>]*>/gi, (match, url: string) => {
        // Skip already-handled images and tiny tracking pixels
        if (match.includes('data-original') || match.includes('data-actualsrc')) return '';
        if (url.includes('equation') || url.includes('zhihu-equation')) {
          // LaTeX equation images — try to preserve alt text
          const altMatch = match.match(/alt="([^"]+)"/);
          return altMatch ? ` ${altMatch[1]} ` : '';
        }
        return `\n![](${url})\n`;
      });

      // Convert <figure> captions
      text = text.replace(/<figcaption[^>]*>(.*?)<\/figcaption>/gi, (_, caption: string) => {
        const clean = caption.replace(/<[^>]+>/g, '').trim();
        return clean ? `\n_${clean}_\n` : '';
      });

      // Preserve headings
      text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level: string, content: string) => {
        const hashes = '#'.repeat(Number(level));
        const clean = content.replace(/<[^>]+>/g, '').trim();
        return `\n${hashes} ${clean}\n`;
      });

      // Convert <p> to paragraphs
      text = text.replace(/<\/p>/gi, '\n\n');
      text = text.replace(/<p[^>]*>/gi, '');

      // Convert <br> to newlines
      text = text.replace(/<br\s*\/?>/gi, '\n');

      // Convert <blockquote> to > prefixed
      text = text.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, content: string) => {
        const clean = content.replace(/<[^>]+>/g, '').trim();
        return `\n> ${clean.replace(/\n/g, '\n> ')}\n`;
      });

      // Convert <a> to [text](url)
      text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href: string, linkText: string) => {
        const clean = linkText.replace(/<[^>]+>/g, '').trim();
        if (!clean || clean === href) return href;
        return `[${clean}](${href})`;
      });

      // Convert lists
      text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, (_, content: string) => {
        const clean = content.replace(/<[^>]+>/g, '').trim();
        return `\n- ${clean}`;
      });
      text = text.replace(/<\/?[ou]l[^>]*>/gi, '\n');

      // Convert <code> and <pre>
      text = text.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, (_, code: string) => {
        const clean = code
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim();
        return `\n\`\`\`\n${clean}\n\`\`\`\n`;
      });
      text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, (_, code: string) => {
        const clean = code.replace(/<[^>]+>/g, '').trim();
        return `\`${clean}\``;
      });

      // Bold and italic
      text = text.replace(/<(?:strong|b)[^>]*>(.*?)<\/(?:strong|b)>/gi, (_, c: string) => {
        const clean = c.replace(/<[^>]+>/g, '').trim();
        return `**${clean}**`;
      });
      text = text.replace(/<(?:em|i)[^>]*>(.*?)<\/(?:em|i)>/gi, (_, c: string) => {
        const clean = c.replace(/<[^>]+>/g, '').trim();
        return `*${clean}*`;
      });

      // Remove remaining HTML tags
      text = text.replace(/<[^>]+>/g, '');

      // Decode HTML entities
      text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&hellip;/g, '…')
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

      // Clean up excessive whitespace
      text = text.replace(/\n{3,}/g, '\n\n').trim();

      return text;
    } catch {
      // Fallback: strip all HTML
      return html
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // ──────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────

  /**
   * Like request(), but does NOT mark cookie as invalid on 403.
   * Used for content endpoints where 403 is typically anti-scraping, not auth failure.
   */
  private async requestContent<T>(url: string): Promise<T> {
    await this.throttle();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Cookie: this.cookie,
            'User-Agent': this.userAgent,
            Referer: 'https://www.zhihu.com/',
            Accept: 'application/json',
            'x-requested-with': 'fetch',
          },
        });

        this.lastRequestTime = Date.now();

        if (!response.ok) {
          throw new Error(`Zhihu API returned ${response.status}: ${response.statusText}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          `[ZhihuClient] Content request attempt ${attempt + 1}/${this.maxRetries} failed:`,
          lastError.message,
        );

        if (attempt < this.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error('ZhihuClient content request failed');
  }

  private async request<T>(url: string): Promise<T> {
    await this.throttle();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Cookie: this.cookie,
            'User-Agent': this.userAgent,
            Referer: 'https://www.zhihu.com/',
            Accept: 'application/json',
          },
        });

        this.lastRequestTime = Date.now();

        if (response.status === 401 || response.status === 403) {
          this.failCount++;
          this.cookieValid = false;
          throw new Error(`Zhihu API returned ${response.status} — cookie may be invalid`);
        }

        if (!response.ok) {
          throw new Error(`Zhihu API returned ${response.status}: ${response.statusText}`);
        }

        this.failCount = 0;
        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(`[ZhihuClient] Request attempt ${attempt + 1}/${this.maxRetries} failed:`, lastError.message);

        if (attempt < this.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    this.failCount++;
    throw lastError ?? new Error('ZhihuClient request failed');
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.requestIntervalMs) {
      await new Promise((r) => setTimeout(r, this.requestIntervalMs - elapsed));
    }
  }

  private extractCursorFromUrl(nextUrl: string): string | undefined {
    if (!nextUrl) return undefined;
    try {
      const url = new URL(nextUrl);
      return url.searchParams.get('after_id') ?? undefined;
    } catch {
      // Try regex fallback for relative URLs
      const match = nextUrl.match(/after_id=([^&]+)/);
      return match?.[1];
    }
  }
}
