// ZhihuClient — HTTP client for Zhihu private API
// Handles cookie management, rate limiting, and retry logic

import { logger } from '@/utils/logger';
import type { ZhihuFeedItem, ZhihuMomentsResponse, ZhihuUser } from './types';

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
        logger.warn(`[ZhihuClient] Request attempt ${attempt + 1}/${this.maxRetries} failed:`, {
          message: lastError.message,
          url: url,
        });

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
