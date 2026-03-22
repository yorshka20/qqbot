/**
 * Test: verify fetch-based API access with new cookie.
 * Run: bun run src/services/zhihu/zhihu-puppeteer.test.ts
 */
import { loadConfigAuto } from '@/core/config/loadConfigDir';

// biome-ignore lint/suspicious/noExplicitAny: test script
const config = loadConfigAuto('config.d') as any;
// biome-ignore lint/suspicious/noExplicitAny: test script
const cookie: string = config.plugins?.list?.find((p: any) => p.name === 'zhihuFeed')?.config?.cookie ?? '';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function testFetch(label: string, url: string) {
  console.log(`\n--- ${label} ---`);
  console.log(`  URL: ${url}`);

  const resp = await fetch(url, {
    headers: {
      Cookie: cookie,
      'User-Agent': UA,
      Referer: 'https://www.zhihu.com/',
      Accept: 'application/json',
      'x-requested-with': 'fetch',
    },
  });

  console.log(`  Status: ${resp.status} ${resp.statusText}`);

  if (resp.ok) {
    const json = await resp.json();
    console.log(`  ✅ Success!`);
    if (json.title) console.log(`  Title: ${json.title}`);
    if (json.author?.name) console.log(`  Author: ${json.author.name}`);
    if (json.content) console.log(`  Content: ${json.content.length} chars`);
    if (json.question?.title) console.log(`  Question: ${json.question.title}`);
    if (json.name) console.log(`  User: ${json.name}`);
  } else {
    const text = await resp.text();
    console.log(`  ❌ Failed: ${text.slice(0, 200)}`);
    // Show response headers that might hint at what's needed
    console.log(`  Response headers:`);
    for (const [k, v] of resp.headers.entries()) {
      if (k.startsWith('x-') || k === 'www-authenticate') {
        console.log(`    ${k}: ${v}`);
      }
    }
  }
}

async function main() {
  // Test 1: /me endpoint (should work)
  await testFetch('User info (/me)', 'https://www.zhihu.com/api/v4/me');

  // Test 2: Feed API (should work)
  await testFetch('Feed (/moments)', 'https://www.zhihu.com/api/v3/moments?desktop=true&limit=3');

  // Test 3: Answer content API (the one that 403s)
  await testFetch('Answer content', 'https://www.zhihu.com/api/v4/answers/2017885791959942952?include=content');

  // Test 4: Article content API
  await testFetch('Article content', 'https://www.zhihu.com/api/v4/articles/2017687791295808300');
}

main();
