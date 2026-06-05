// Owns the VKB bearer-token lifecycle.
//
// VKB issues HMAC tokens with a 7-day TTL via POST /api/v1/auth/verify and
// exposes no refresh endpoint — the only durable credential is the access
// password. So instead of persisting an expiring token in config (which goes
// stale by design), this manager holds the password and mints tokens on
// demand, caching the live token plus its decoded expiry.
//
// A token dies in two distinct ways; each has its own refresh trigger:
//   - proactive: the cached token is within EXPIRY_SKEW_MS of its `exp` →
//                re-mint before the next request goes out.
//   - reactive : a request still 401s with a non-expired token, which happens
//                when VKB restarts with a freshly-generated authSecret and
//                invalidates every outstanding token at once. `exp` can't see
//                that — the caller catches the 401, calls invalidate(), and the
//                next getToken() re-mints. This is the correctness backstop.
//
// When only a static token is configured (no password), it is returned as-is
// with no refresh — backward-compatible with the manual-rotation setup.

import type { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import type { VKBAuthVerifyResponse } from './types';

const LOG_TAG = '[VKBTokenManager]';

// Mint a fresh token this many ms before the server-side expiry so an in-flight
// request never races the boundary — the skew absorbs request latency and
// minor clock drift between this host and VKB.
const EXPIRY_SKEW_MS = 60_000;

export class VKBTokenManager {
  private readonly httpClient: HttpClient;
  private readonly password?: string;
  private readonly staticToken?: string;
  private cached: { token: string; expMs: number } | null = null;
  // Single-flight guard: parallel fetchGlossary calls that all find the cache
  // stale share one /auth/verify mint instead of stampeding the endpoint.
  private inflight: Promise<string | null> | null = null;

  constructor(opts: { httpClient: HttpClient; password?: string; staticToken?: string }) {
    this.httpClient = opts.httpClient;
    this.password = opts.password?.trim() || undefined;
    this.staticToken = opts.staticToken?.trim() || undefined;
  }

  /** A 401 is only worth retrying when we can mint a new token — i.e. password mode. */
  get canRefresh(): boolean {
    return !!this.password;
  }

  /** Current bearer token, minting/refreshing as needed. null when no auth is configured. */
  async getToken(): Promise<string | null> {
    if (this.password) return this.getManagedToken();
    return this.staticToken ?? null;
  }

  /** Drop the cached token so the next getToken() re-mints. No-op in static-token mode. */
  invalidate(): void {
    this.cached = null;
  }

  private async getManagedToken(): Promise<string | null> {
    const cached = this.cached;
    if (cached && Date.now() < cached.expMs - EXPIRY_SKEW_MS) {
      return cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(): Promise<string | null> {
    try {
      const res = await this.httpClient.post<VKBAuthVerifyResponse>('/api/v1/auth/verify', {
        password: this.password,
      });
      if (!res?.success || !res.token) {
        logger.warn(`${LOG_TAG} auth/verify rejected: ${res?.message ?? 'no token in response'}`);
        return null;
      }
      // A token whose exp we can't read still works; we just can't cache it
      // safely, so stamp it already-stale (expMs 0) → next call re-mints. The
      // 401 retry path stays the correctness backstop.
      this.cached = { token: res.token, expMs: decodeTokenExpMs(res.token) ?? 0 };
      return res.token;
    } catch (err) {
      logger.warn(`${LOG_TAG} auth/verify failed:`, err);
      return null;
    }
  }
}

/**
 * Decode the `exp` (Unix milliseconds) from a VKB token. The format is
 * base64url(json{exp}) + "." + base64url(hmac) — see VKB internal/server/auth.go.
 * Returns null when the payload can't be parsed.
 */
export function decodeTokenExpMs(token: string): number | null {
  const payloadB64 = token.split('.', 1)[0];
  if (!payloadB64) return null;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}
