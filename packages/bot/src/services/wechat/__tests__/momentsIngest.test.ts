// Tests for WechatMomentsIngestService
// Uses mocked PadProClient and RetrievalService to verify:
// 1. Normal ingest flow (parse, download, upsert)
// 2. Pagination via maxId
// 3. sinceTimestamp boundary stops fetching
// 4. Empty moments are skipped
// 5. Image download failure is handled gracefully
// 6. RAG disabled throws error

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { resolve } from 'node:path';
import type { RAGDocument } from '@/services/retrieval';
import { parseMomentObjectDesc } from '../moments/momentsParser';
import { WechatMomentsIngestService } from '../moments/WechatMomentsIngestService';
import type { WeChatPadProClient, WXMoment } from '../WeChatPadProClient';

// ────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ────────────────────────────────────────────────────────────────────────────

/** Build a base64-encoded objectDesc XML that the parser can handle. */
function makeObjectDescBuffer(contentDesc: string, mediaCount = 0): string {
  const mediaItems = Array.from(
    { length: mediaCount },
    (_, i) =>
      `<media><id>media_${i}</id><type>2</type><url type="1">https://cdn.example.com/img_${i}.jpg</url><thumb type="1">https://cdn.example.com/thumb_${i}.jpg</thumb></media>`,
  ).join('');

  const xml =
    `<TimelineObject>` +
    `<contentDesc>${contentDesc}</contentDesc>` +
    `<contentStyle>1</contentStyle>` +
    (mediaItems ? `<mediaList>${mediaItems}</mediaList>` : '') +
    `</TimelineObject>`;

  return Buffer.from(xml).toString('base64');
}

function makeMoment(id: number, text: string, createTime: number, mediaCount = 0): WXMoment {
  return {
    id: String(id),
    userName: 'self',
    nickName: 'Me',
    createTime,
    objectDescBuffer: makeObjectDescBuffer(text, mediaCount),
  };
}

function createMockRetrieval(ragEnabled = true) {
  const upsertedDocs: { collection: string; documents: RAGDocument[] }[] = [];
  return {
    service: {
      isRAGEnabled: () => ragEnabled,
      upsertDocuments: mock(async (collection: string, documents: RAGDocument[]) => {
        upsertedDocs.push({ collection, documents });
      }),
    } as unknown as import('@/services/retrieval').RetrievalService,
    upsertedDocs,
  };
}

function createMockClient(pages: WXMoment[][]) {
  let callIndex = 0;
  return {
    getMomentsTimeline: mock(async (_maxId?: number): Promise<WXMoment[]> => {
      const page = pages[callIndex] ?? [];
      callIndex++;
      return page;
    }),
  } as unknown as WeChatPadProClient;
}

// ────────────────────────────────────────────────────────────────────────────
// Unit tests (mocked client + mocked fetch)
// ────────────────────────────────────────────────────────────────────────────

describe('WechatMomentsIngestService', () => {
  // Stub global fetch for image download tests — scoped to this describe block
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('cdn.example.com')) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (url.includes('fail.example.com')) {
        return new Response(null, { status: 500 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  test('ingests moments and upserts to Qdrant', async () => {
    const now = Math.floor(Date.now() / 1000);
    const moments = [
      makeMoment(1001, 'First post about AI', now - 3600, 2),
      makeMoment(1002, 'Second post about music', now - 1800),
      makeMoment(1003, 'Third post with link', now - 600),
    ];
    const client = createMockClient([moments, []]); // page 1 returns data, page 2 empty
    const { service: retrieval, upsertedDocs } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] ingest result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBe(3);
    expect(result.ingested).toBe(3);
    expect(result.skippedEmpty).toBe(0);
    expect(result.newestTimestamp).toBe(now - 600);
    expect(result.oldestTimestamp).toBe(now - 3600);

    // Verify upsert was called
    expect(upsertedDocs.length).toBe(1);
    expect(upsertedDocs[0].collection).toBe('wechat_moments');
    expect(upsertedDocs[0].documents.length).toBe(3);

    // Verify document content
    const doc0 = upsertedDocs[0].documents[0];
    expect(doc0.id).toBe('moment_1001');
    expect(doc0.content).toContain('First post about AI');
    expect(doc0.payload?.type).toBe('1');
    expect(doc0.payload?.medias_count).toBe(2);
    expect(doc0.payload?.source).toBe('padpro_ingest');

    console.log('[test] upserted doc sample:', JSON.stringify(doc0, null, 2));
  });

  test('paginates via maxId across multiple pages', async () => {
    const now = Math.floor(Date.now() / 1000);
    const page1 = [makeMoment(100, 'Page 1 moment A', now - 100), makeMoment(200, 'Page 1 moment B', now - 200)];
    const page2 = [makeMoment(300, 'Page 2 moment C', now - 300)];
    const client = createMockClient([page1, page2, []]);
    const { service: retrieval, upsertedDocs } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] pagination result:', JSON.stringify(result, null, 2));

    // getMomentsTimeline should be called 3 times (page1, page2, empty)
    expect((client.getMomentsTimeline as ReturnType<typeof mock>).mock.calls.length).toBe(3);
    expect(result.fetched).toBe(3);
    expect(result.ingested).toBe(3);

    // Total upserted across batches
    const totalDocs = upsertedDocs.reduce((sum, batch) => sum + batch.documents.length, 0);
    expect(totalDocs).toBe(3);
  });

  test('stops at sinceTimestamp boundary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 2000;
    const moments = [
      makeMoment(1, 'Recent', now - 500),
      makeMoment(2, 'Borderline', now - 1500),
      makeMoment(3, 'Old - should be excluded', now - 3000), // before cutoff
    ];
    const client = createMockClient([moments]);
    const { service: retrieval, upsertedDocs } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ sinceTimestamp: cutoff, downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] sinceTimestamp result:', JSON.stringify(result, null, 2));

    // Only 2 moments should be fetched (the 3rd is at cutoff boundary)
    expect(result.fetched).toBe(2);
    expect(result.ingested).toBe(2);
  });

  test('skips empty moments (no content, no media, no link)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const emptyBuffer = Buffer.from('<TimelineObject><contentDesc></contentDesc></TimelineObject>').toString('base64');
    const moments: WXMoment[] = [
      makeMoment(1, 'Has content', now - 100),
      { id: '2', createTime: now - 200, objectDescBuffer: emptyBuffer }, // empty
      { id: '3', createTime: now - 300 }, // no objectDescBuffer at all
      makeMoment(4, 'Also has content', now - 400),
    ];
    const client = createMockClient([moments, []]);
    const { service: retrieval } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] skip empty result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBe(4);
    expect(result.ingested).toBe(2);
    expect(result.skippedEmpty).toBe(2);
  });

  test('downloads images and reports counts', async () => {
    const now = Math.floor(Date.now() / 1000);
    const moments = [makeMoment(1, 'Post with images', now - 100, 3)];
    const client = createMockClient([moments, []]);
    const { service: retrieval, upsertedDocs } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: true, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] image download result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.imagesDownloaded).toBe(3);
    expect(result.imagesFailed).toBe(0);

    // Verify image_paths in payload
    const doc = upsertedDocs[0].documents[0];
    const paths = doc.payload?.image_paths as string[];
    expect(paths).toBeDefined();
    expect(paths.length).toBe(3);
    console.log('[test] image_paths:', paths);
  });

  test('handles image download failure gracefully', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Build moment with a failing image URL
    const xml =
      `<TimelineObject>` +
      `<contentDesc>Post with bad image</contentDesc>` +
      `<contentStyle>1</contentStyle>` +
      `<mediaList>` +
      `<media><id>good</id><type>2</type><url type="1">https://cdn.example.com/ok.jpg</url><thumb type="1"></thumb></media>` +
      `<media><id>bad</id><type>2</type><url type="1">https://fail.example.com/broken.jpg</url><thumb type="1"></thumb></media>` +
      `</mediaList>` +
      `</TimelineObject>`;

    const moments: WXMoment[] = [
      { id: '1', createTime: now - 100, objectDescBuffer: Buffer.from(xml).toString('base64') },
    ];
    const client = createMockClient([moments, []]);
    const { service: retrieval } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: true, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] mixed image result:', JSON.stringify(result, null, 2));

    expect(result.imagesDownloaded).toBe(1);
    expect(result.imagesFailed).toBe(1);
    // Should still ingest the moment itself
    expect(result.ingested).toBe(1);
  });

  test('respects maxTotal limit', async () => {
    const now = Math.floor(Date.now() / 1000);
    const moments = Array.from({ length: 10 }, (_, i) => makeMoment(i + 1, `Post ${i}`, now - i * 100));
    const client = createMockClient([moments]);
    const { service: retrieval } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ maxTotal: 5, downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] maxTotal result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBe(5);
    expect(result.ingested).toBe(5);
  });

  test('throws when RAG is disabled', async () => {
    const client = createMockClient([]);
    const { service: retrieval } = createMockRetrieval(false);

    const svc = new WechatMomentsIngestService(client, retrieval);

    let error: Error | null = null;
    try {
      await svc.ingest();
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('RAG is not enabled');
    console.log('[test] RAG disabled error:', error?.message);
  });

  test('handles empty first page gracefully', async () => {
    const client = createMockClient([[]]);
    const { service: retrieval } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(client, retrieval);
    const result = await svc.ingest({ downloadImages: false, pageDelayMs: 0, imageDelayMs: 0 });

    console.log('[test] empty page result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBe(0);
    expect(result.ingested).toBe(0);
    expect(result.oldestTimestamp).toBe(0);
    expect(result.newestTimestamp).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Live API tests — uses direct HTTP calls to PadPro API
//
// Safe to run while bot is running: no WeChatPadProClient instantiation,
// just raw HTTP POST to the same endpoint. The real data is then fed into
// the ingest service via a mock client wrapper (no session conflict).
// ────────────────────────────────────────────────────────────────────────────

interface PadProConfig {
  apiBase: string;
  authKey: string;
  wxid?: string;
}

function loadPadProConfig(): PadProConfig | null {
  const { loadConfigAuto } = require('@/core/config/loadConfigDir') as typeof import('@/core/config/loadConfigDir');
  const configDir = resolve(process.cwd(), 'config.d');
  let raw: Record<string, unknown>;
  try {
    raw = loadConfigAuto(configDir);
  } catch {
    return null;
  }
  const plugins = (raw?.plugins as { list?: Array<{ name: string; config?: Record<string, unknown> }> })?.list ?? [];
  const wechat = plugins.find((p) => p.name === 'wechatIngest');
  const padpro = wechat?.config?.padpro as PadProConfig | undefined;
  if (padpro?.apiBase && padpro?.authKey) {
    return { apiBase: padpro.apiBase, authKey: padpro.authKey, wxid: padpro.wxid };
  }
  return null;
}

/** Direct HTTP call to PadPro — no client instance needed. Uses SendSnsUserPage (own moments only) when wxid is provided. */
async function fetchMomentsRaw(config: PadProConfig, maxId = 0): Promise<WXMoment[]> {
  // Use SendSnsUserPage with own wxid to fetch only own moments; fallback to SendSnsTimeLine (all friends)
  const endpoint = config.wxid ? '/sns/SendSnsUserPage' : '/sns/SendSnsTimeLine';
  const url = `${config.apiBase}${endpoint}?key=${encodeURIComponent(config.authKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ UserName: config.wxid ?? '', MaxID: maxId, FirstPageMD5: '' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json()) as { Code: number; Data?: { objectList?: Array<Record<string, unknown>> } };
  if (json.Code !== 200) throw new Error(`API Code=${json.Code}`);

  return (json.Data?.objectList ?? []).map((o) => ({
    id: String(o.id ?? ''),
    userName: o.username as string | undefined,
    nickName: o.nickname as string | undefined,
    createTime: o.createTime as number | undefined,
    objectDescBuffer: (o.objectDesc as { buffer?: string })?.buffer,
  }));
}

const padproConfig = loadPadProConfig();
const SKIP_LIVE = process.env.NETWORK_TESTS !== '1' || !padproConfig;

if (SKIP_LIVE) {
  console.warn('[momentsIngest.test] NETWORK_TESTS not set or padpro not configured — live tests skipped');
}

describe('WechatMomentsIngest — Live API (direct HTTP)', () => {
  test('fetch real moments and validate parse result', async () => {
    if (SKIP_LIVE) {
      console.log('skipped — no padpro config');
      return;
    }

    const moments = await fetchMomentsRaw(padproConfig!);

    console.log(`[live] fetched ${moments.length} moments via direct HTTP`);
    expect(moments.length).toBeGreaterThan(0);

    for (const m of moments.slice(0, 5)) {
      console.log(
        `\n[live] moment id=${m.id} user=${m.userName} nick=${m.nickName} time=${m.createTime} (${m.createTime ? new Date(m.createTime * 1000).toISOString() : '?'})`,
      );

      expect(m.id).toBeTruthy();
      expect(typeof m.createTime).toBe('number');
      expect(m.createTime!).toBeGreaterThan(0);

      if (m.objectDescBuffer) {
        const parsed = parseMomentObjectDesc(m.objectDescBuffer);
        const desc = (parsed?.contentDesc ?? '(empty)').slice(0, 150);
        console.log(`[live]   style=${parsed?.contentStyle} media=${parsed?.mediaList?.length ?? 0} desc="${desc}"`);
        if (parsed?.title) console.log(`[live]   title: ${parsed.title}`);
        if (parsed?.contentUrl) console.log(`[live]   url: ${parsed.contentUrl.slice(0, 100)}`);

        if (parsed) {
          expect(typeof parsed.contentDesc).toBe('string');
          expect(Array.isArray(parsed.mediaList)).toBe(true);
        }
      }
    }
  });

  test('full ingest pipeline with real data (mock Qdrant)', async () => {
    if (SKIP_LIVE) {
      console.log('skipped — no padpro config');
      return;
    }

    // Fetch real data once, then wrap in a mock client to feed into ingest service
    const realMoments = await fetchMomentsRaw(padproConfig!);
    expect(realMoments.length).toBeGreaterThan(0);

    const mockClient = createMockClient([realMoments.slice(0, 5), []]);
    const { service: retrieval, upsertedDocs } = createMockRetrieval();

    const svc = new WechatMomentsIngestService(mockClient, retrieval);
    const result = await svc.ingest({
      maxTotal: 5,
      downloadImages: false, // set to true to test real image download
      pageDelayMs: 0,
      imageDelayMs: 0,
    });

    console.log('[live] ingest result:', JSON.stringify(result, null, 2));

    expect(result.fetched).toBeGreaterThan(0);
    expect(result.fetched).toBeLessThanOrEqual(5);
    // Some moments may be empty (skipped), but at least some should be ingested
    expect(result.ingested + result.skippedEmpty).toBe(result.fetched);

    if (result.ingested > 0) {
      expect(result.newestTimestamp).toBeGreaterThan(0);
      expect(result.oldestTimestamp).toBeGreaterThan(0);

      for (const batch of upsertedDocs) {
        expect(batch.collection).toBe('wechat_moments');
        for (const doc of batch.documents) {
          console.log(`[live]   doc id=${doc.id}`);
          console.log(`[live]   content: "${doc.content.slice(0, 120)}${doc.content.length > 120 ? '...' : ''}"`);
          console.log(`[live]   payload:`, JSON.stringify(doc.payload, null, 2));

          expect(doc.id).toBeTruthy();
          expect(doc.content.length).toBeGreaterThan(0);
          expect(doc.payload?.create_time).toBeTruthy();
          expect(doc.payload?.source).toBe('padpro_ingest');
        }
      }
    } else {
      console.log('[live] all moments were empty — no documents ingested (still valid)');
    }
  });
});
