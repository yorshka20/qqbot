// VideoKnowledgeClient against an in-process fake video-knowledge-backend: auth, the analyze
// statuses, and waiting on the task stream (terminal events, reconnects, the wait deadline).

import { afterEach, describe, expect, test } from 'bun:test';
import type { Config, VideoKnowledgeConfig } from '@/core/config';
import type { VideoKnowledgeAnalysis } from '../types';
import { VideoKnowledgeClient } from '../VideoKnowledgeClient';

const PASSWORD = 'test-password';
const VIDEO_ID = 'BV1TEST00001';

const READY: VideoKnowledgeAnalysis = {
  status: 'ready',
  video_id: VIDEO_ID,
  result: {
    video_info: {
      platform: 'bilibili',
      video_id: VIDEO_ID,
      title: '测试视频标题',
      duration: 125,
      creator: { platform: 'bilibili', id: '10000001', name: '测试UP主' },
      stats: { view_count: 12_345, like_count: 678, comment_count: 9, danmaku_count: 10 },
    },
    summary: '测试摘要',
    highlights: [{ start_sec: 61, end_sec: 70, title: '高光甲', description: '描述乙' }],
    peaks: [
      { start_sec: 30, end_sec: 40, count: 23, density: 2.3, peak_rank: 1, top_overlays: ['弹幕一', '弹幕二'] },
    ],
  },
};

function tokenFor(serial: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 3600_000, n: serial })).toString('base64url');
  return `${payload}.sig`;
}

/** One scripted answer to a stream connection: SSE frames, then close (or stay open). */
interface StreamScript {
  frames: string[];
  keepOpen?: boolean;
  status?: number;
}

interface FakeBackend {
  url: string;
  mints: number;
  analyzeBodies: unknown[];
  streamConnections: number;
  /** Make every outstanding token invalid, as a backend restart with a new secret does. */
  rotateSecret(): void;
  stop(): void;
}

const backends: FakeBackend[] = [];
afterEach(() => {
  for (const backend of backends) {
    backend.stop();
  }
  backends.length = 0;
});

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startBackend(opts: {
  analyze?: (body: { url: string }) => Response;
  streams?: StreamScript[];
}): FakeBackend {
  let validToken = '';
  let serial = 0;
  const streams = [...(opts.streams ?? [])];
  const state = {
    mints: 0,
    analyzeBodies: [] as unknown[],
    streamConnections: 0,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/api/v1/health') {
        return Response.json({ status: 'ok' });
      }
      if (path === '/api/v1/auth/verify') {
        const body = (await req.json()) as { password?: string };
        if (body.password !== PASSWORD) {
          return Response.json({ success: false, message: 'wrong password' }, { status: 401 });
        }
        state.mints++;
        validToken = tokenFor(++serial);
        return Response.json({ success: true, token: validToken });
      }
      if (!validToken || req.headers.get('authorization') !== `Bearer ${validToken}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (path === '/api/v1/analyze' && req.method === 'POST') {
        const body = (await req.json()) as { url: string };
        state.analyzeBodies.push(body);
        return opts.analyze ? opts.analyze(body) : Response.json({ error: 'no analyze handler' }, { status: 500 });
      }
      if (/^\/api\/v1\/tasks\/\d+\/stream$/.test(path)) {
        state.streamConnections++;
        const script = streams.shift();
        if (!script) {
          return new Response('no more scripted streams', { status: 500 });
        }
        if (script.status) {
          return Response.json({ error: 'scripted failure' }, { status: script.status });
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of script.frames) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            if (!script.keepOpen) {
              controller.close();
            }
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const backend: FakeBackend = {
    url: `http://127.0.0.1:${server.port}`,
    get mints() {
      return state.mints;
    },
    get analyzeBodies() {
      return state.analyzeBodies;
    },
    get streamConnections() {
      return state.streamConnections;
    },
    rotateSecret() {
      validToken = '';
    },
    stop: () => server.stop(true),
  };
  backends.push(backend);
  return backend;
}

function clientFor(backend: FakeBackend, overrides: Partial<VideoKnowledgeConfig> = {}): VideoKnowledgeClient {
  const config: VideoKnowledgeConfig = { enabled: true, baseURL: backend.url, authPassword: PASSWORD, ...overrides };
  return new VideoKnowledgeClient({ getVideoKnowledgeConfig: () => config } as unknown as Config);
}

describe('VideoKnowledgeClient.submitAnalysis', () => {
  test('posts the raw input as url with a minted bearer token', async () => {
    const backend = startBackend({
      analyze: () =>
        Response.json({ status: 'queued', platform: 'bilibili', video_id: VIDEO_ID, task_id: 42 }, { status: 202 }),
    });
    const input = '【测试】 https://b23.tv/AbCdEfG 看看';
    const res = await clientFor(backend).submitAnalysis(input);
    expect(res).toEqual({ status: 'queued', platform: 'bilibili', video_id: VIDEO_ID, task_id: 42 });
    expect(backend.analyzeBodies).toEqual([{ url: input }]);
    expect(backend.mints).toBe(1);
  });

  test('returns an analyzed video with its existing analysis', async () => {
    const backend = startBackend({
      analyze: () =>
        Response.json({ status: 'analyzed', platform: 'bilibili', video_id: VIDEO_ID, task_id: 7, analysis: READY }),
    });
    const res = await clientFor(backend).submitAnalysis(VIDEO_ID);
    expect(res.status).toBe('analyzed');
    expect(res.status === 'analyzed' && res.analysis).toEqual(READY);
  });

  test('returns a held video with its last error', async () => {
    const backend = startBackend({
      analyze: () =>
        Response.json({ status: 'held', platform: 'bilibili', video_id: VIDEO_ID, task_id: 9, error: 'stage fetch failed' }),
    });
    const res = await clientFor(backend).submitAnalysis(VIDEO_ID);
    expect(res).toMatchObject({ status: 'held', error: 'stage fetch failed', task_id: 9 });
  });

  test('turns a 400 into unresolvable', async () => {
    const backend = startBackend({
      analyze: () => Response.json({ error: 'cannot resolve a video from url: no video' }, { status: 400 }),
    });
    const res = await clientFor(backend).submitAnalysis('没有链接的一句话');
    expect(res).toEqual({ status: 'unresolvable', error: 'cannot resolve a video from url: no video' });
  });

  test('re-mints the token once on 401 and retries', async () => {
    const backend = startBackend({
      analyze: () => Response.json({ status: 'active', platform: 'bilibili', video_id: VIDEO_ID, task_id: 5 }, { status: 202 }),
    });
    const client = clientFor(backend);
    await client.submitAnalysis(VIDEO_ID);
    backend.rotateSecret();
    const res = await client.submitAnalysis(VIDEO_ID);
    expect(res.status).toBe('active');
    expect(backend.mints).toBe(2);
    expect(backend.analyzeBodies).toHaveLength(2);
  });

  test('surfaces a 401 when the password is wrong', async () => {
    const backend = startBackend({});
    const err = await clientFor(backend, { authPassword: 'wrong' })
      .submitAnalysis(VIDEO_ID)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(401);
  });
});

describe('VideoKnowledgeClient.waitForTask', () => {
  test('resolves with the analysis of a complete event split across chunks', async () => {
    const complete = frame('complete', { task_id: 42, video_id: VIDEO_ID, analysis: READY });
    const backend = startBackend({
      streams: [
        {
          frames: [
            frame('connected', { task_id: 42 }),
            frame('stage_start', { stage: 'fetch', elapsed_ms: 0, extra: null }),
            complete.slice(0, 25),
            complete.slice(25),
          ],
        },
      ],
    });
    expect(await clientFor(backend).waitForTask(42)).toEqual({
      status: 'complete',
      analysis: READY,
      alreadyAnalyzed: false,
    });
  });

  test('reports already_analyzed from the complete event', async () => {
    const backend = startBackend({
      streams: [{ frames: [frame('complete', { task_id: 3, video_id: VIDEO_ID, already_analyzed: true, analysis: READY })] }],
    });
    expect(await clientFor(backend).waitForTask(3)).toMatchObject({ status: 'complete', alreadyAnalyzed: true });
  });

  test('keeps waiting through retrying and ends on fatal_error', async () => {
    const backend = startBackend({
      streams: [
        {
          frames: [
            frame('connected', { task_id: 8 }),
            frame('retrying', { error: 'llm timeout', attempt: 1 }),
            frame('fatal_error', { error: 'pipeline failed: stage llm_analyze' }),
          ],
        },
      ],
    });
    expect(await clientFor(backend).waitForTask(8)).toEqual({
      status: 'failed',
      error: 'pipeline failed: stage llm_analyze',
    });
  });

  test('reconnects after the stream timeout event', async () => {
    const backend = startBackend({
      streams: [
        { frames: [frame('connected', { task_id: 4 }), frame('timeout', { reason: 'stream timeout after 30m0s' })] },
        { frames: [frame('connected', { task_id: 4 }), frame('complete', { task_id: 4, video_id: VIDEO_ID, analysis: READY })] },
      ],
    });
    expect(await clientFor(backend).waitForTask(4)).toMatchObject({ status: 'complete' });
    expect(backend.streamConnections).toBe(2);
  });

  test('reconnects when the connection drops without a terminal event', async () => {
    const backend = startBackend({
      streams: [
        { frames: [frame('connected', { task_id: 6 }), frame('stage_start', { stage: 'fetch' })] },
        { frames: [frame('fatal_error', { error: 'boom' })] },
      ],
    });
    expect(await clientFor(backend).waitForTask(6)).toEqual({ status: 'failed', error: 'boom' });
    expect(backend.streamConnections).toBe(2);
  });

  test('reconnects after a 5xx answer to the stream request', async () => {
    const backend = startBackend({
      streams: [{ frames: [], status: 503 }, { frames: [frame('complete', { task_id: 2, video_id: VIDEO_ID, analysis: READY })] }],
    });
    expect(await clientFor(backend).waitForTask(2)).toMatchObject({ status: 'complete' });
    expect(backend.streamConnections).toBe(2);
  });

  test('re-mints the token when the stream answers 401', async () => {
    const backend = startBackend({
      analyze: () => Response.json({ status: 'queued', platform: 'bilibili', video_id: VIDEO_ID, task_id: 1 }, { status: 202 }),
      streams: [{ frames: [frame('complete', { task_id: 1, video_id: VIDEO_ID, analysis: READY })] }],
    });
    const client = clientFor(backend);
    await client.submitAnalysis(VIDEO_ID);
    backend.rotateSecret();
    expect(await client.waitForTask(1)).toMatchObject({ status: 'complete' });
    expect(backend.mints).toBe(2);
  });

  test('throws on a 4xx answer instead of reconnecting', async () => {
    const backend = startBackend({ streams: [{ frames: [], status: 400 }] });
    const err = await clientFor(backend)
      .waitForTask(1)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(backend.streamConnections).toBe(1);
  });

  test('gives up with timeout when the wait deadline passes on an open stream', async () => {
    const backend = startBackend({ streams: [{ frames: [frame('connected', { task_id: 11 })], keepOpen: true }] });
    const started = Date.now();
    expect(await clientFor(backend, { waitTimeoutMs: 150 }).waitForTask(11)).toEqual({ status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('ends with timeout when the caller aborts', async () => {
    const backend = startBackend({ streams: [{ frames: [frame('connected', { task_id: 12 })], keepOpen: true }] });
    const abort = new AbortController();
    const waiting = clientFor(backend).waitForTask(12, { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    expect(await waiting).toEqual({ status: 'timeout' });
  });
});

describe('VideoKnowledgeClient.formatAnalysis', () => {
  test('renders a ready analysis', () => {
    const backend = startBackend({});
    const text = clientFor(backend).formatAnalysis(READY);
    expect(text).toContain('📺 测试视频标题');
    expect(text).toContain('👤 测试UP主 | ⏱ 2:05');
    expect(text).toContain('👀 1.2万 | 👍 678');
    expect(text).toContain('📝 内容摘要:\n测试摘要');
    expect(text).toContain('  [1:01] 高光甲 — 描述乙');
    expect(text).toContain('  [0:30] 23条弹幕 — 弹幕一、弹幕二');
  });

  test('explains an analysis without a report', () => {
    const backend = startBackend({});
    const client = clientFor(backend);
    expect(client.formatAnalysis({ status: 'not_found', video_id: VIDEO_ID })).toBe(
      `视频 ${VIDEO_ID} 已分析入库，但没有可展示的报告`,
    );
    expect(client.formatAnalysis({ status: 'unavailable', video_id: VIDEO_ID })).toBe(
      `视频 ${VIDEO_ID} 已分析入库，但没有可展示的报告`,
    );
    expect(
      client.formatAnalysis({
        status: 'failed',
        video_id: VIDEO_ID,
        progress: { task_status: 'failed', error_msg: 'stage fetch' },
      }),
    ).toBe(`❌ 视频 ${VIDEO_ID} 分析失败: stage fetch`);
  });
});
