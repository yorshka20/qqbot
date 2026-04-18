/**
 * Test: verify fetch-based API access with new cookie.
 * Requires NETWORK_TESTS=1:  NETWORK_TESTS=1 bun run src/services/zhihu/zhihu-puppeteer.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { loadConfigAuto } from '@/core/config/loadConfigDir';

function loadZhihuCookie(): string | null {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: test script
    const config = loadConfigAuto('config.d') as any;
    // biome-ignore lint/suspicious/noExplicitAny: test script
    const cookie: string = config.plugins?.list?.find((p: any) => p.name === 'zhihuFeed')?.config?.cookie ?? '';
    return cookie || null;
  } catch {
    return null;
  }
}

const cookie = loadZhihuCookie();
const SKIP = process.env.NETWORK_TESTS !== '1' || !cookie;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function testFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Cookie: cookie ?? '',
      'User-Agent': UA,
      Referer: 'https://www.zhihu.com/',
      Accept: 'application/json',
      'x-requested-with': 'fetch',
    },
  });
}

describe.skipIf(SKIP)('Zhihu API (real network)', () => {
  test('GET /me returns user info', async () => {
    const resp = await testFetch('https://www.zhihu.com/api/v4/me');
    expect(resp.ok).toBe(true);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.name).toBeDefined();
  });

  test('GET /moments returns feed', async () => {
    const resp = await testFetch('https://www.zhihu.com/api/v3/moments?desktop=true&limit=3');
    expect(resp.ok).toBe(true);
  });

  test('GET answer content', async () => {
    const resp = await testFetch('https://www.zhihu.com/api/v4/answers/2017885791959942952?include=content');
    expect(resp.ok).toBe(true);
  });

  test('GET article content', async () => {
    const resp = await testFetch('https://www.zhihu.com/api/v4/articles/2017687791295808300');
    expect(resp.ok).toBe(true);
  });
});
