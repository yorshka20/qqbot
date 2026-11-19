// The whole memory batch path against a real batch host, on a throwaway SQLite database and
// synthetic chat: extract → consolidate as two batches, facts written, usage priced as batch.
// A batch can sit in the queue for a while, so this needs its own switch on top of NETWORK_TESTS.
//
// Run: NETWORK_TESTS=1 BATCH_TESTS=1 bun test packages/bot/src/memory/batch/__tests__/MemoryBatchQueue.network.test.ts

import 'reflect-metadata';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchService } from '@qqbot/llm';
import type { RetrievalService } from '@qqbot/retrieval/service';
import { getRepoRoot } from '@qqbot/shared';
import { PromptManager } from '@/ai/prompt/PromptManager';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
} from '@/ai/services/__tests__/integrationTestHelpers';
import type { Config } from '@/core/config';
import { DatabaseManager } from '@/database/DatabaseManager';
import { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { MemoryConsolidationService } from '../../consolidation/MemoryConsolidationService';
import { MemoryExtractService } from '../../extraction/MemoryExtractService';
import { GROUP_MEMORY_USER_ID } from '../../model/constants';
import { MemoryReviewService } from '../../review/MemoryReviewService';
import { ManualMemoryStore } from '../../storage/ManualMemoryStore';
import { MemoryFactStore } from '../../storage/MemoryFactStore';
import { MemoryIndex } from '../../storage/MemoryIndex';
import { MemoryBatchQueue } from '../MemoryBatchQueue';

const HOST = 'sail';
const TIMEOUT_MS = 30 * 60_000;
const GROUP = '10000001';
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const CHAT_LOG = [
  '[20:01] 测试用户甲(20000001): 我下个月搬去杭州了，以后周末可以一起爬山',
  '[20:02] 测试用户乙(20000002): 欢迎欢迎，我在杭州住了五年，西湖边的山我都熟',
  '[20:03] 测试用户丙(20000003): 先说好，我对花生过敏，聚餐别点带花生的菜',
  '[20:05] 测试用户甲(20000001): 记住了。我平时只喝无糖的茶，奶茶一口都不碰',
  '[20:06] 测试用户乙(20000002): 那下周六上午九点在北山路集合，谁来谁报名',
].join('\n');

const enabled = process.env.BATCH_TESTS === '1' && getIntegrationProvider(HOST) !== null;
const dir = mkdtempSync(join(tmpdir(), 'memory-batch-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)(`memory batch queue on ${HOST} (real API)`, () => {
  test(
    'extracts and consolidates synthetic chat through two batches and prices them as batch usage',
    async () => {
      const databaseManager = new DatabaseManager();
      await databaseManager.initialize({ type: 'sqlite', sqlite: { path: join(dir, 'bot.db') } });
      const config = {
        getMemoryConfig: () => ({ dir: join(dir, 'memory') }),
        getAIConfig: () => ({
          providers: {},
          batchPricing: { [HOST]: { [MODEL]: { input: 0.05, cachedInput: 0.004, output: 0.15 } } },
        }),
      } as unknown as Config;
      const promptManager = new PromptManager(join(getRepoRoot(), 'prompts'));
      const index = new MemoryIndex({ getRAGService: () => null } as unknown as RetrievalService);
      const store = new MemoryFactStore(databaseManager, index);
      const manual = new ManualMemoryStore(config);
      const usage = new TokenUsageService(databaseManager, config);
      const queue = new MemoryBatchQueue(
        databaseManager,
        new BatchService(createAIManagerWithProvider(HOST)),
        new MemoryExtractService(promptManager),
        new MemoryConsolidationService(promptManager, store, manual),
        new MemoryReviewService(config, promptManager, store, manual),
        usage,
      );

      const started = Date.now();
      const handle = await queue.enqueueExtract(GROUP, CHAT_LOG);
      let outcome: { applied: number; dropped: number } | null = null;
      void handle.settled.then((o) => {
        outcome = o;
      });
      while (!outcome && Date.now() - started < TIMEOUT_MS) {
        // Past the submit delay on every pass, so nothing waits for company.
        await queue.tick(Date.now() + 10 * 60_000);
        if (!outcome) {
          await Bun.sleep(5_000);
        }
      }
      console.log(`[memory batch] settled after ${((Date.now() - started) / 1000).toFixed(0)}s:`, outcome);

      const jobs = await databaseManager.getAdapter().getModel('memoryBatchJobs').find({});
      for (const job of jobs) {
        console.log(`[memory batch] ${job.kind} ${job.userId || '-'} ${job.status} batch=${job.batchId}`);
      }
      const facts = await store.listGroup(GROUP, 'active');
      for (const fact of facts) {
        console.log(`[memory batch] fact ${fact.userId} [${fact.scope}] ${fact.content}`);
      }
      const report = await usage.getDailyReport(usage.getLocalDate(), 10);
      console.log('[memory batch] usage (USD, tokens):', report.cost, report.totalTokens);

      expect(outcome).not.toBeNull();
      expect(outcome!.dropped).toBe(0);
      expect(jobs.filter((job) => job.kind === 'consolidate').length).toBeGreaterThan(0);
      expect(jobs.every((job) => job.status === 'done')).toBe(true);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((fact) => fact.userId !== GROUP_MEMORY_USER_ID)).toBe(true);
      const batchRows = (await databaseManager.getAdapter().getModel('tokenUsage').find({})).filter((row) => row.batch);
      expect(batchRows.length).toBe(jobs.length);
      expect(report.unpricedModels).toEqual([]);
      expect(report.cost).toBeGreaterThan(0);

      await databaseManager.close();
    },
    TIMEOUT_MS + 60_000,
  );
});
