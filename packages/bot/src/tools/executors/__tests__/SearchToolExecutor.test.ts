// A failed search and an empty search are different answers. Collapsing them —
// as the old `catch → return []` in SearchService did — let the model report a
// dead backend to users as "there is nothing about this".

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { RetrievalService } from '@/services/retrieval';
import type { SearchResult } from '@/services/retrieval/searxng/types';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { SearchToolExecutor } from '../SearchToolExecutor';

const callWith = (queries: unknown): ToolCall => ({ type: 'search', executor: 'search', parameters: { queries } });
const call = callWith(['gamescom 2026']);
const context: ToolExecutionContext = { userId: 1, messageType: 'private' };

const hit = (title: string): SearchResult => ({ title, url: `https://x.test/${title}`, snippet: `about ${title}` });

function executorWith(retrieval: Partial<RetrievalService>): SearchToolExecutor {
  return new SearchToolExecutor(retrieval as RetrievalService);
}

describe('search tool result contract', () => {
  it('reports a backend failure as an error, not as an empty result', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: () => Promise.reject(new Error('Serper API error: 400 Not enough credits')),
    });

    const result = await executor.execute(call, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not enough credits');
    expect(result.reply).toContain('Not enough credits');
  });

  it('reports a genuinely empty result as a success the model can read', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: () => Promise.resolve([[]]),
      formatSearchResults: () => '',
    });

    const result = await executor.execute(call, context);

    expect(result.success).toBe(true);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('reports a disabled search as an error rather than silent emptiness', async () => {
    const executor = executorWith({ isSearchEnabled: () => false });

    const result = await executor.execute(call, context);

    expect(result.success).toBe(false);
  });
});

describe('search tool multi-query', () => {
  it('passes every query to the backend in one batch', async () => {
    let received: string[] = [];
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: (queries) => {
        received = queries;
        return Promise.resolve(queries.map((q) => [hit(q)]));
      },
      formatSearchResults: (results) => results.map((r) => r.title).join(','),
    });

    const result = await executor.execute(callWith(['bun 2.0 release', 'bun 2.0 breaking changes']), context);

    expect(received).toEqual(['bun 2.0 release', 'bun 2.0 breaking changes']);
    expect(result.success).toBe(true);
  });

  it('keeps each query results under its own heading so answers stay attributable', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: (queries) => Promise.resolve(queries.map((q) => [hit(q)])),
      formatSearchResults: (results) => results.map((r) => r.title).join(','),
    });

    const result = await executor.execute(callWith(['alpha', 'beta']), context);

    expect(result.reply).toContain('查询：alpha');
    expect(result.reply).toContain('查询：beta');
  });

  it('still succeeds when only some of the queries found nothing', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: (queries) => Promise.resolve(queries.map((q, i) => (i === 0 ? [hit(q)] : []))),
      formatSearchResults: (results) => results.map((r) => r.title).join(','),
    });

    const result = await executor.execute(callWith(['found', 'missing']), context);

    expect(result.success).toBe(true);
    expect(result.reply).toContain('found');
  });

  // Models emit a bare string for a one-element array often enough that rejecting
  // it would spend a round re-asking for the same search.
  it('accepts a bare string as a single query', async () => {
    let received: string[] = [];
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: (queries) => {
        received = queries;
        return Promise.resolve([[hit('x')]]);
      },
      formatSearchResults: () => 'x',
    });

    const result = await executor.execute(callWith('single query'), context);

    expect(received).toEqual(['single query']);
    expect(result.success).toBe(true);
  });

  it('drops duplicate and blank queries rather than paying for them twice', async () => {
    let received: string[] = [];
    const executor = executorWith({
      isSearchEnabled: () => true,
      searchBatch: (queries) => {
        received = queries;
        return Promise.resolve(queries.map(() => [hit('x')]));
      },
      formatSearchResults: () => 'x',
    });

    await executor.execute(callWith(['dup', 'dup', '  ', 'other']), context);

    expect(received).toEqual(['dup', 'other']);
  });

  it('rejects a call with no usable query', async () => {
    const executor = executorWith({ isSearchEnabled: () => true });

    const result = await executor.execute(callWith([]), context);

    expect(result.success).toBe(false);
  });
});
