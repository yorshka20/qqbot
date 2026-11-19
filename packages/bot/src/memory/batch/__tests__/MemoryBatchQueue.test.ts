// The memory batch queue against an in-memory jobs table and a scripted batch host: the
// extract → consolidate chain, resuming from the table alone, failure and retry, per-slot
// serialization with merging, usage accounting, and replaying an answer without duplicates.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { BatchJob, BatchRequest, BatchResult, BatchService } from '@qqbot/llm';
import { join } from 'node:path';
import { getRepoRoot } from '@qqbot/shared';
import { PromptManager } from '@/ai/prompt/PromptManager';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryBatchJob } from '@/database/models/types';
import type { SystemLLMCall, TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import type { MemoryConsolidationService } from '../../consolidation/MemoryConsolidationService';
import { MemoryExtractService } from '../../extraction/MemoryExtractService';
import type { MemoryRequest } from '../../llm/memoryLLM';
import { GROUP_MEMORY_USER_ID } from '../../model/constants';
import type { MemoryReviewService } from '../../review/MemoryReviewService';
import { MemoryBatchQueue } from '../MemoryBatchQueue';

const GROUP = '10000001';
const USER_A = '20000001';
const LATER = () => Date.now() + 3 * 60_000;

/** Enough of ModelAccessor<MemoryBatchJob> for the queue, over a plain map. */
function makeTable() {
  const rows = new Map<string, MemoryBatchJob>();
  let seq = 0;
  const matches = (row: MemoryBatchJob, criteria: Partial<MemoryBatchJob>) =>
    Object.entries(criteria).every(([key, value]) => value === undefined || row[key as keyof MemoryBatchJob] === value);
  const model = {
    async create(data: Omit<MemoryBatchJob, 'createdAt' | 'updatedAt'>) {
      // Distinct, ordered creation times without waiting.
      const at = new Date(Date.now() + seq++);
      const row = { ...data, createdAt: at, updatedAt: at } as MemoryBatchJob;
      rows.set(row.id, row);
      return { ...row };
    },
    async findById(id: string) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async find(criteria: Partial<MemoryBatchJob>, options?: { orderBy?: string }) {
      const found = [...rows.values()].filter((row) => matches(row, criteria)).map((row) => ({ ...row }));
      if (options?.orderBy === 'createdAt') {
        found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return found;
    },
    async update(id: string, data: Partial<MemoryBatchJob>) {
      const row = rows.get(id);
      if (!row) {
        throw new Error(`no row ${id}`);
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    async delete(id: string) {
      return rows.delete(id);
    },
  };
  const databaseManager = {
    getAdapter: () => ({ isConnected: () => true, getModel: () => model }),
  } as unknown as DatabaseManager;
  return { rows, databaseManager };
}

type Answer = (request: BatchRequest) => BatchResult;

/** A batch host whose batches finish when `finish()` is called, answering each request through `answer`. */
function makeBatchHost(answer: Answer, provider: 'sail' | null = 'sail') {
  const submitted: Array<{ id: string; requests: BatchRequest[] }> = [];
  const finished = new Set<string>();
  const job = (id: string, status: BatchJob['status']): BatchJob => ({
    id,
    provider: 'sail',
    status,
    createdAt: new Date().toISOString(),
    totalRequests: 0,
    succeededRequests: 0,
    failedRequests: 0,
  });
  const service = {
    cheapestProvider: () => provider,
    async submitBatch(_provider: string, requests: BatchRequest[]) {
      const id = `batch-${submitted.length + 1}`;
      submitted.push({ id, requests });
      return job(id, 'processing');
    },
    async getBatchStatus(_provider: string, id: string) {
      return job(id, finished.has(id) ? 'succeeded' : 'processing');
    },
    async getBatchResults(_provider: string, id: string) {
      const batch = submitted.find((b) => b.id === id);
      return (batch?.requests ?? []).map(answer);
    },
  } as unknown as BatchService;
  return {
    service,
    submitted,
    finishAll: () => {
      for (const batch of submitted) {
        finished.add(batch.id);
      }
    },
  };
}

function ok(request: BatchRequest, text: string): BatchResult {
  return {
    customId: request.customId,
    status: 'succeeded',
    response: {
      text,
      resolvedModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedPromptTokens: 200 },
    },
  };
}

const EXTRACT_ANSWER = JSON.stringify({
  group_facts: [{ scope: 'topic', content: '群里常聊数码产品' }],
  user_facts: [{ user_id: USER_A, facts: [{ scope: 'preference', content: '喜欢喝茶' }] }],
});
const OPERATIONS_ANSWER = JSON.stringify({ operations: [{ op: 'add', scope: 'topic', content: '群里常聊数码产品' }] });

/** Answers by prompt: an extraction gets EXTRACT_ANSWER, everything else OPERATIONS_ANSWER. */
const answerByPrompt: Answer = (request) =>
  ok(request, request.prompt.includes('PREPARED') ? OPERATIONS_ANSWER : EXTRACT_ANSWER);

function makeQueue(answer: Answer = answerByPrompt, provider: 'sail' | null = 'sail', table = makeTable()) {
  const host = makeBatchHost(answer, provider);
  const prepared: Array<{ userId: string; candidates: string[] }> = [];
  const applied: Array<{ userId: string; request: MemoryRequest; jobId: string }> = [];
  const consolidation = {
    async prepareSlot(_groupId: string, userId: string, candidates: string[]) {
      prepared.push({ userId, candidates });
      return { prompt: `PREPARED ${userId}`, factIds: ['f1'], dueIds: [] };
    },
    async applySlotAnswer(_groupId: string, userId: string, request: MemoryRequest, _answer: unknown, jobId: string) {
      applied.push({ userId, request, jobId });
    },
  } as unknown as MemoryConsolidationService;
  const review = {
    async prepareSlotReview() {
      return { prompt: 'PREPARED review', factIds: ['f1'], dueIds: ['f1'] };
    },
    async applyReviewAnswer() {},
  } as unknown as MemoryReviewService;
  const usage: SystemLLMCall[] = [];
  const tokenUsage = {
    async recordBatchLLM(call: SystemLLMCall) {
      usage.push(call);
      return 0;
    },
  } as unknown as TokenUsageService;
  const extract = new MemoryExtractService(new PromptManager(join(getRepoRoot(), 'prompts')));
  const queue = new MemoryBatchQueue(table.databaseManager, host.service, extract, consolidation, review, tokenUsage);
  return { queue, host, table, prepared, applied, usage };
}

/** Tick until the queue's rows are all finished, finishing every batch between ticks. */
async function drain(env: ReturnType<typeof makeQueue>, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await env.queue.tick(LATER());
    env.host.finishAll();
  }
  await env.queue.tick(LATER());
}

describe('MemoryBatchQueue', () => {
  it('runs an extract, then one consolidation per slot it found, and settles the extract with them', async () => {
    const env = makeQueue();
    const handle = await env.queue.enqueueExtract(GROUP, '[10:00] 测试用户甲(20000001): 今天又泡了一壶茶');

    await drain(env);

    expect(env.host.submitted.map((b) => b.requests.length)).toEqual([1, 2]);
    expect(env.prepared.map((p) => p.userId).sort()).toEqual([GROUP_MEMORY_USER_ID, USER_A].sort());
    expect(env.prepared.find((p) => p.userId === USER_A)?.candidates).toEqual(['[preference] 喜欢喝茶']);
    expect(env.applied.map((a) => a.request.factIds)).toEqual([['f1'], ['f1']]);
    expect(await handle.settled).toEqual({ applied: 3, dropped: 0 });
  });

  it('waits for company before submitting, then submits on the next tick past the delay', async () => {
    const env = makeQueue();
    await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);

    await env.queue.tick(Date.now());
    expect(env.host.submitted).toHaveLength(0);

    await env.queue.tick(LATER());
    expect(env.host.submitted).toHaveLength(1);
    expect(env.host.submitted[0].requests[0].options).toMatchObject({ jsonMode: true, reasoningEffort: 'medium' });
  });

  it('resumes from the table alone: a fresh queue collects and applies what another one submitted', async () => {
    const first = makeQueue();
    await first.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);
    await first.queue.tick(LATER());
    expect([...first.table.rows.values()].map((row) => row.status)).toEqual(['submitted']);

    const second = makeQueue(answerByPrompt, 'sail', first.table);
    // The batch lives at the host; the second process only knows its id from the row.
    second.host.submitted.push(...first.host.submitted);
    second.host.finishAll();
    await second.queue.tick(LATER());

    expect(second.applied).toHaveLength(1);
    expect([...first.table.rows.values()].map((row) => row.status)).toEqual(['done']);
  });

  it('queues a failed job again once, then drops it, and settles its waiter as dropped', async () => {
    const env = makeQueue((request) => ({ customId: request.customId, status: 'errored', error: 'HTTP 500' }));
    const handle = await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);

    await drain(env);

    expect(env.host.submitted).toHaveLength(2);
    const [row] = env.table.rows.values();
    expect(row).toMatchObject({ status: 'dropped', attempts: 2, error: 'HTTP 500' });
    expect(await handle.settled).toEqual({ applied: 0, dropped: 1 });
  });

  it('treats an unreadable answer as a failure', async () => {
    const env = makeQueue((request) => ok(request, '不是 JSON'));
    await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);

    await drain(env);

    expect([...env.table.rows.values()][0]).toMatchObject({ status: 'dropped', attempts: 2 });
    expect(env.applied).toHaveLength(0);
  });

  it('keeps one job per slot in flight and merges the slot’s queued consolidations at submission', async () => {
    const env = makeQueue();
    const first = await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);
    await env.queue.tick(LATER());
    const second = await env.queue.enqueueConsolidation(GROUP, USER_A, ['[identity] 在南方工作']);
    const third = await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 不吃辣']);

    await env.queue.tick(LATER());
    expect(env.host.submitted).toHaveLength(1);

    await drain(env);

    expect(env.prepared.map((p) => p.candidates)).toEqual([
      ['[preference] 喜欢喝茶'],
      ['[identity] 在南方工作', '[preference] 不吃辣'],
    ]);
    expect(env.table.rows.get(third.id)).toMatchObject({ status: 'merged', mergedInto: second.id });
    expect(await first.settled).toEqual({ applied: 1, dropped: 0 });
    expect(await third.settled).toEqual({ applied: 1, dropped: 0 });
  });

  it('records each fetched request as batch usage with the host and the model that answered', async () => {
    const env = makeQueue();
    await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);

    await drain(env);

    expect(env.usage).toEqual([
      {
        provider: 'sail',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedPromptTokens: 200 },
      },
    ]);
  });

  it('leaves jobs queued while no batch provider is configured', async () => {
    const env = makeQueue(answerByPrompt, null);
    await env.queue.enqueueConsolidation(GROUP, USER_A, ['[preference] 喜欢喝茶']);

    await env.queue.tick(LATER());

    expect([...env.table.rows.values()][0].status).toBe('queued');
  });

  it('replaying an extract answer spawns no second consolidation', async () => {
    const env = makeQueue();
    const { id } = await env.queue.enqueueExtract(GROUP, '[10:00] 测试用户甲(20000001): 今天又泡了一壶茶');
    await env.queue.tick(LATER());
    env.host.finishAll();
    await env.queue.tick(LATER());
    const children = () => [...env.table.rows.values()].filter((row) => row.parentId === id);
    expect(children()).toHaveLength(2);

    await env.table.databaseManager.getAdapter().getModel('memoryBatchJobs').update(id, { status: 'fetched' });
    await env.queue.tick(LATER());

    expect(children()).toHaveLength(2);
    expect(env.table.rows.get(id)?.status).toBe('done');
  });

  it('returns the slot’s pending review instead of queuing a second one', async () => {
    const env = makeQueue();
    const first = await env.queue.enqueueReview(GROUP, USER_A);
    const second = await env.queue.enqueueReview(GROUP, USER_A);

    expect(second.id).toBe(first.id);
    expect(env.table.rows.size).toBe(1);
  });
});
