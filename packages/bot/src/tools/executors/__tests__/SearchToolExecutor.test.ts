// A failed search and an empty search are different answers. Collapsing them —
// as the old `catch → return []` in SearchService did — let the model report a
// dead backend to users as "there is nothing about this".

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { RetrievalService } from '@/services/retrieval';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { SearchToolExecutor } from '../SearchToolExecutor';

const call: ToolCall = { type: 'search', executor: 'search', parameters: { query: 'gamescom 2026' } };
const context: ToolExecutionContext = { userId: 1, messageType: 'private' };

function executorWith(retrieval: Partial<RetrievalService>): SearchToolExecutor {
  return new SearchToolExecutor(retrieval as RetrievalService);
}

describe('search tool result contract', () => {
  it('reports a backend failure as an error, not as an empty result', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      search: () => Promise.reject(new Error('Serper API error: 400 Not enough credits')),
    });

    const result = await executor.execute(call, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not enough credits');
    expect(result.reply).toContain('Not enough credits');
  });

  it('reports a genuinely empty result as a success the model can read', async () => {
    const executor = executorWith({
      isSearchEnabled: () => true,
      search: () => Promise.resolve([]),
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
