import { describe, expect, it } from 'bun:test';
import type { UsageDailyReport, UsageReportResponse } from '@qqbot/api-types';
import type { TokenUsageService } from '../TokenUsageService';
import { UsageBackend } from '../UsageBackend';

function makeReport(date: string): UsageDailyReport {
  return {
    date,
    userCount: 1,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    totalImages: 0,
    cost: 1.5,
    unpricedModels: ['model-x'],
    topUsers: [
      {
        userId: '10000001',
        nickname: '测试用户甲',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        totalImages: 0,
        cost: 1.5,
        byProvider: [],
      },
    ],
  };
}

function makeBackend(opts: { fail?: boolean } = {}) {
  const calls: Array<{ date: string; limit: number }> = [];
  const service = {
    getLocalDate: () => '2026-01-02',
    getDailyReport: async (date: string, limit: number) => {
      calls.push({ date, limit });
      if (opts.fail) {
        throw new Error('db down');
      }
      return makeReport(date);
    },
  } as unknown as TokenUsageService;
  return { backend: new UsageBackend(service), calls };
}

const get = (path: string) => new Request(`http://localhost${path}`);

describe('UsageBackend', () => {
  it('returns the report for the requested date', async () => {
    const { backend, calls } = makeBackend();
    const res = await backend.handle('/api/usage', get('/api/usage?date=2025-12-31'));
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as UsageReportResponse;
    expect(body.report.date).toBe('2025-12-31');
    expect(body.report.topUsers[0].userId).toBe('10000001');
    expect(calls).toEqual([{ date: '2025-12-31', limit: 100 }]);
  });

  it('defaults to the local date', async () => {
    const { backend } = makeBackend();
    const res = await backend.handle('/api/usage', get('/api/usage'));
    const body = (await res?.json()) as UsageReportResponse;
    expect(body.report.date).toBe('2026-01-02');
  });

  it('rejects a malformed date with 400', async () => {
    const { backend, calls } = makeBackend();
    const res = await backend.handle('/api/usage', get('/api/usage?date=2026-1-2'));
    expect(res?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('answers an unknown path with 404', async () => {
    const { backend } = makeBackend();
    const res = await backend.handle('/api/usage/other', get('/api/usage/other'));
    expect(res?.status).toBe(404);
  });

  it('refuses non-GET and ignores other prefixes', async () => {
    const { backend } = makeBackend();
    const post = await backend.handle('/api/usage', new Request('http://localhost/api/usage', { method: 'POST' }));
    expect(post?.status).toBe(405);
    expect(await backend.handle('/api/stats', get('/api/stats'))).toBeNull();
  });

  it('returns 500 when the report fails', async () => {
    const { backend } = makeBackend({ fail: true });
    const res = await backend.handle('/api/usage', get('/api/usage'));
    expect(res?.status).toBe(500);
  });
});
