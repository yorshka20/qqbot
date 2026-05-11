// Jina Reader integration — turns any public URL into clean markdown
// for LLM consumption. Free tier is used (no Authorization header);
// expect ~20 req/min before 429s. Caller is responsible for guarding
// internal/LAN URLs (see urlGuards.isInternalUrl) before invoking.

import type { JinaReaderConfig } from '@/core/config/types/mcp';
import { logger } from '@/utils/logger';

const DEFAULT_BASE_URL = 'https://r.jina.ai';
const DEFAULT_TIMEOUT_MS = 15000;

/** Heuristic patterns that indicate the page is a login/access wall, not real content. */
const LOGIN_WALL_PATTERNS = [
  /\b(?:please\s+)?(?:log[\s-]?in|sign[\s-]?in|sign[\s-]?up|register)\b/i,
  /access\s+denied/i,
  /\b(?:401|403)\b/,
  /请(?:先)?登[录陆]/,
  /需要登[录陆]/,
];

export interface JinaFetchResult {
  /** Full Jina Reader response body, normalized to single trailing newline. */
  text: string;
  /** True when Jina returned content but it looked like a login wall. Caller may choose to discard. */
  isLoginWall: boolean;
}

export class JinaReaderService {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: JinaReaderConfig | undefined) {
    this.enabled = config?.enabled ?? false;
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Math.max(2000, config?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Fetch a URL through Jina Reader. Returns null on any failure
   * (network error, non-2xx, timeout, empty body).
   */
  async fetch(url: string): Promise<JinaFetchResult | null> {
    if (!this.enabled) return null;

    const target = `${this.baseUrl}/${url}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(target, {
        method: 'GET',
        // Free-tier mode: no Authorization header.
        headers: { Accept: 'text/plain' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(`[JinaReaderService] ${url} → status ${response.status}`);
        return null;
      }

      const body = (await response.text()).trim();
      if (!body) {
        logger.debug(`[JinaReaderService] ${url} → empty body`);
        return null;
      }

      return {
        text: body,
        isLoginWall: detectLoginWall(body),
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn(`[JinaReaderService] Timeout fetching ${url}`);
      } else {
        logger.warn(`[JinaReaderService] Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }
}

/**
 * Treat as login wall when content is unusually short AND matches a login-related pattern.
 * Short threshold avoids flagging long articles that merely mention "login" in body text.
 */
function detectLoginWall(text: string): boolean {
  if (text.length > 500) return false;
  return LOGIN_WALL_PATTERNS.some((p) => p.test(text));
}
