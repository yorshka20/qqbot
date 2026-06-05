import { describe, expect, it } from 'bun:test';
import type { HttpClient } from '@/api/http/HttpClient';
import { decodeTokenExpMs, VKBTokenManager } from '../VKBTokenManager';

// Build a VKB-shaped token: base64url(json{exp}) + "." + <sig>. Only the
// payload matters here — the manager never verifies the HMAC (the server does).
function tokenWithExp(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expMs })).toString('base64url');
  return `${payload}.sig`;
}

// Minimal HttpClient stub recording every /auth/verify call.
function stubClient(handler: (body: unknown) => unknown): { client: HttpClient; calls: number } {
  let calls = 0;
  const client = {
    post: async (_url: string, body?: unknown) => {
      calls += 1;
      return handler(body);
    },
  } as unknown as HttpClient;
  return {
    client,
    get calls() {
      return calls;
    },
  };
}

describe('decodeTokenExpMs', () => {
  it('extracts the exp (Unix ms) from a VKB token', () => {
    expect(decodeTokenExpMs(tokenWithExp(1781222046044))).toBe(1781222046044);
  });

  it('returns null for malformed tokens', () => {
    expect(decodeTokenExpMs('not-a-token')).toBeNull();
    expect(decodeTokenExpMs('')).toBeNull();
    expect(decodeTokenExpMs(`${Buffer.from('{}').toString('base64url')}.sig`)).toBeNull();
  });
});

describe('VKBTokenManager — static token mode', () => {
  it('returns the static token unchanged and never mints', async () => {
    const stub = stubClient(() => ({ success: true, token: 'should-not-be-used' }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, staticToken: 'static-tok' });

    expect(await mgr.getToken()).toBe('static-tok');
    expect(stub.calls).toBe(0);
    expect(mgr.canRefresh).toBe(false);
  });

  it('returns null when neither password nor token is configured', async () => {
    const stub = stubClient(() => ({ success: true, token: 'x' }));
    const mgr = new VKBTokenManager({ httpClient: stub.client });
    expect(await mgr.getToken()).toBeNull();
    expect(stub.calls).toBe(0);
  });
});

describe('VKBTokenManager — password mode', () => {
  const farFuture = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

  it('mints once and caches a non-expired token', async () => {
    const stub = stubClient(() => ({ success: true, token: tokenWithExp(farFuture()) }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, password: 'pw' });

    const a = await mgr.getToken();
    const b = await mgr.getToken();
    expect(a).toBe(b);
    expect(stub.calls).toBe(1);
    expect(mgr.canRefresh).toBe(true);
  });

  it('coalesces concurrent mints into a single /auth/verify call', async () => {
    const stub = stubClient(() => ({ success: true, token: tokenWithExp(farFuture()) }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, password: 'pw' });

    const [a, b, c] = await Promise.all([mgr.getToken(), mgr.getToken(), mgr.getToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(stub.calls).toBe(1);
  });

  it('re-mints after invalidate() (the 401-recovery path)', async () => {
    let n = 0;
    const stub = stubClient(() => ({ success: true, token: `${tokenWithExp(farFuture())}-${n++}` }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, password: 'pw' });

    const first = await mgr.getToken();
    mgr.invalidate();
    const second = await mgr.getToken();
    expect(first).not.toBe(second);
    expect(stub.calls).toBe(2);
  });

  it('re-mints proactively when the cached token is within the expiry skew', async () => {
    // exp 30s out — inside the 60s skew, so it must be treated as stale.
    const stub = stubClient(() => ({ success: true, token: tokenWithExp(Date.now() + 30_000) }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, password: 'pw' });

    await mgr.getToken();
    await mgr.getToken();
    expect(stub.calls).toBe(2);
  });

  it('returns null and does not cache when the server rejects the password', async () => {
    const stub = stubClient(() => ({ success: false, message: 'incorrect password' }));
    const mgr = new VKBTokenManager({ httpClient: stub.client, password: 'wrong' });

    expect(await mgr.getToken()).toBeNull();
    expect(await mgr.getToken()).toBeNull();
    expect(stub.calls).toBe(2);
  });
});
