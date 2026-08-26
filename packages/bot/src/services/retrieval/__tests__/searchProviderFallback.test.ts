// The provider order exists so a dead primary (e.g. Serper out of credits)
// degrades to the next backend instead of taking search down. There is no
// pre-flight probe: the request itself is the probe, so a metered backend is
// never billed just to be asked whether it works.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MCPConfig } from '@/core/config/types/mcp';
import type { HealthCheckManager } from '@/core/health';
import type { PageContentFetchService } from '../fetch';
import { SearchService } from '../searxng/SearchService';
import type { SearchResult } from '../searxng/types';

function configWith(order: MCPConfig['search']['fallbackOrder']): MCPConfig {
  return {
    enabled: true,
    searxng: { url: 'http://searxng.test' },
    serper: { apiKey: 'test-key' },
    server: { enabled: false, runtime: 'bunx' },
    search: { enabled: true, provider: 'serper', fallbackOrder: order, mode: 'direct', autoTrigger: false },
  };
}

function serviceWith(config: MCPConfig): SearchService {
  return new SearchService({
    config,
    promptManager: {} as never,
    healthCheckManager: {
      registerService: () => {},
    } as unknown as HealthCheckManager,
    pageContentFetchService: {} as PageContentFetchService,
  });
}

const hit = (title: string): SearchResult[] => [{ title, url: `https://x.test/${title}`, snippet: '' }];

function stub(service: SearchService, serper: () => Promise<SearchResult[]>, searxng: () => Promise<SearchResult[]>) {
  (service as never as { serperClient: unknown }).serperClient = { webSearch: serper };
  (service as never as { searxngClient: unknown }).searxngClient = { webSearch: searxng };
}

describe('search provider fallback', () => {
  it('serves from the primary without probing it first', async () => {
    const service = serviceWith(configWith(['searxng']));
    let searxngCalls = 0;
    stub(
      service,
      () => Promise.resolve(hit('from-serper')),
      () => {
        searxngCalls++;
        return Promise.resolve(hit('from-searxng'));
      },
    );

    expect((await service.search('q')).map((r) => r.title)).toEqual(['from-serper']);
    expect(searxngCalls).toBe(0);
  });

  it('falls through to the next provider when the primary errors', async () => {
    const service = serviceWith(configWith(['searxng']));
    stub(
      service,
      () => Promise.reject(new Error('Serper API error: 400 Not enough credits')),
      () => Promise.resolve(hit('from-searxng')),
    );

    expect((await service.search('q')).map((r) => r.title)).toEqual(['from-searxng']);
  });

  it('keeps trying the primary on later calls — a failure is not sticky', async () => {
    const service = serviceWith(configWith(['searxng']));
    let serperUp = false;
    stub(
      service,
      () => (serperUp ? Promise.resolve(hit('from-serper')) : Promise.reject(new Error('no credits'))),
      () => Promise.resolve(hit('from-searxng')),
    );

    expect((await service.search('q')).map((r) => r.title)).toEqual(['from-searxng']);
    serperUp = true;
    expect((await service.search('q')).map((r) => r.title)).toEqual(['from-serper']);
  });

  it('throws with every provider reason when the whole order fails', async () => {
    const service = serviceWith(configWith(['searxng']));
    stub(
      service,
      () => Promise.reject(new Error('no credits')),
      () => Promise.reject(new Error('connection refused')),
    );

    await expect(service.search('q')).rejects.toThrow(/no credits.*connection refused/s);
  });

  it('does not fall back when no fallbackOrder is configured', async () => {
    const service = serviceWith(configWith(undefined));
    stub(
      service,
      () => Promise.reject(new Error('no credits')),
      () => Promise.resolve(hit('from-searxng')),
    );

    await expect(service.search('q')).rejects.toThrow(/no credits/);
  });
});
