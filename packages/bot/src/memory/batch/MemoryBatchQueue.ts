// Every memory LLM job runs through here, on a provider batch API: nothing in memory calls a
// model in realtime.
//
// A job is a `memory_batch_jobs` row and the row is all of its state, so a restart picks up
// where the last process stopped. `tick()` (driven by MemoryPlugin's timer, and only by the bot
// process — two processes would submit and apply the same rows) moves rows along:
//
//   queued ──submit──▶ submitted ──fetch──▶ fetched ──apply──▶ done
//      ▲                    │                   │
//      └──── failed, attempts left ─────────────┘──▶ dropped once they run out
//
// An extract job's answer spawns one consolidation job per slot. A slot (group memory or one
// member's) has at most one job in flight, so a consolidation or review always reads the slot
// as the previous one left it; queued consolidations of the same slot are merged into one at
// submission.

import type { BatchProviderName, BatchResult, BatchService } from '@qqbot/llm';
import { logger, randomUUID } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryBatchJob } from '@/database/models/types';
import { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { MemoryConsolidationService } from '../consolidation/MemoryConsolidationService';
import { MemoryExtractService } from '../extraction/MemoryExtractService';
import { MEMORY_REQUEST_OPTIONS, type MemoryRequest, parseMemoryJson } from '../llm/memoryLLM';
import { childJobId } from '../model/jobIds';
import { MemoryReviewService } from '../review/MemoryReviewService';

/** How long the oldest queued job waits for company before a batch is submitted. */
const SUBMIT_AFTER_MS = 2 * 60_000;
/** Submit at once past this many queued jobs. */
const SUBMIT_AT_COUNT = 1000;
const MAX_ATTEMPTS = 2;
/**
 * Sail's Flex tier promises no completion time and Sail has no cancel endpoint; a batch still
 * running after this is given up on, and its results are ignored if they arrive later.
 */
const GIVE_UP_AFTER_MS = 48 * 60 * 60_000;
/** Finished rows are kept this long for inspection, then deleted. */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

const IN_FLIGHT: ReadonlySet<MemoryBatchJob['status']> = new Set(['submitted', 'fetched']);
const FINISHED: ReadonlySet<MemoryBatchJob['status']> = new Set(['done', 'dropped', 'merged']);

export interface MemoryJobOutcome {
  /** Jobs of this one's tree that were applied / given up on (an extract counts its consolidations). */
  applied: number;
  dropped: number;
}

export interface MemoryJobHandle {
  id: string;
  /** Settles when the job and every job it spawned are applied or given up on; in this process only. */
  settled: Promise<MemoryJobOutcome>;
}

interface ExtractInput {
  system?: string;
  prompt: string;
}

interface ConsolidateInput {
  candidates: string[];
}

type NewJob = Pick<MemoryBatchJob, 'kind' | 'groupId' | 'userId' | 'parentId'> & { id?: string; input: object };

@singleton()
export class MemoryBatchQueue {
  private readonly waiters = new Map<string, Array<(outcome: MemoryJobOutcome) => void>>();
  private running: Promise<void> | null = null;
  private warnedNoProvider = false;

  constructor(
    @inject(DatabaseManager) private readonly databaseManager: DatabaseManager,
    @inject(DITokens.BATCH_SERVICE) private readonly batch: BatchService,
    @inject(MemoryExtractService) private readonly extract: MemoryExtractService,
    @inject(MemoryConsolidationService) private readonly consolidation: MemoryConsolidationService,
    @inject(MemoryReviewService) private readonly review: MemoryReviewService,
    @inject(TokenUsageService) private readonly usage: TokenUsageService,
  ) {}

  /** A chat log to extract from; with `focusUserId` only that member's facts are kept. */
  async enqueueExtract(groupId: string, chatLog: string, focusUserId?: string): Promise<MemoryJobHandle> {
    return this.enqueuePrompt(groupId, this.extract.renderExtractRequest(groupId, chatLog, focusUserId), focusUserId);
  }

  /** An extraction prompt rendered elsewhere (the group_day fan-out's shared day log plus its task). */
  async enqueuePrompt(groupId: string, input: ExtractInput, focusUserId?: string): Promise<MemoryJobHandle> {
    const row = await this.create({ kind: 'extract', groupId, userId: focusUserId ?? '', parentId: '', input });
    return this.handle(row.id);
  }

  async enqueueConsolidation(groupId: string, userId: string, candidates: string[]): Promise<MemoryJobHandle> {
    const input: ConsolidateInput = { candidates };
    const row = await this.create({ kind: 'consolidate', groupId, userId, parentId: '', input });
    return this.handle(row.id);
  }

  /** A review of the slot's due facts; the slot's pending review when it already has one. */
  async enqueueReview(groupId: string, userId: string): Promise<MemoryJobHandle> {
    const pending = (await this.model().find({ kind: 'review', groupId, userId })).find(
      (row) => !FINISHED.has(row.status),
    );
    const row = pending ?? (await this.create({ kind: 'review', groupId, userId, parentId: '', input: {} }));
    return this.handle(row.id);
  }

  /** One pass: collect finished batches, apply their answers, submit what is due. Never throws. */
  tick(now = Date.now()): Promise<void> {
    if (!this.running) {
      this.running = this.runTick(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runTick(now: number): Promise<void> {
    try {
      await this.collect(now);
      await this.applyFetched();
      await this.submitDue(now);
      await this.settleWaiters();
      await this.purgeFinished(now);
    } catch (err) {
      logger.error('[MemoryBatchQueue] tick failed:', err);
    }
  }

  // ── collect ────────────────────────────────────────────────────────────────

  private async collect(now: number): Promise<void> {
    const byBatch = new Map<string, MemoryBatchJob[]>();
    for (const row of await this.model().find({ status: 'submitted' })) {
      const key = `${row.provider}\n${row.batchId}`;
      byBatch.set(key, [...(byBatch.get(key) ?? []), row]);
    }
    for (const rows of byBatch.values()) {
      await this.collectBatch(rows, now);
    }
  }

  private async collectBatch(rows: MemoryBatchJob[], now: number): Promise<void> {
    const { provider, batchId, submittedAt } = rows[0];
    const name = provider as BatchProviderName;
    let status: string;
    try {
      status = (await this.batch.getBatchStatus(name, batchId)).status;
    } catch (err) {
      logger.warn(`[MemoryBatchQueue] status of ${provider} batch ${batchId} unavailable:`, err);
      return;
    }
    if (status === 'pending' || status === 'processing') {
      if (now - submittedAt > GIVE_UP_AFTER_MS) {
        logger.warn(`[MemoryBatchQueue] ${provider} batch ${batchId} still ${status} after 48h, giving up on it`);
        for (const row of rows) {
          await this.fail(row, `batch ${batchId} gave up after 48h`);
        }
      }
      return;
    }
    let results: BatchResult[] = [];
    try {
      results = await this.batch.getBatchResults(name, batchId);
    } catch (err) {
      logger.warn(`[MemoryBatchQueue] results of ${provider} batch ${batchId} (${status}) unavailable:`, err);
    }
    const byId = new Map(results.map((result) => [result.customId, result]));
    let fetched = 0;
    for (const row of rows) {
      const result = byId.get(row.id);
      if (result?.status !== 'succeeded' || !result.response) {
        await this.fail(row, result?.error ?? `${result?.status ?? 'missing'} in ${status} batch ${batchId}`);
        continue;
      }
      // Sail may expire a result minutes after it is first delivered: store it before anything else.
      await this.model().update(row.id, { status: 'fetched', answer: result.response.text ?? '' });
      fetched++;
      if (result.response.usage) {
        await this.usage.recordBatchLLM({
          provider,
          model: result.response.resolvedModel,
          usage: result.response.usage,
        });
      }
    }
    logger.info(`[MemoryBatchQueue] ${provider} batch ${batchId} ${status}: fetched ${fetched}/${rows.length}`);
  }

  // ── apply ──────────────────────────────────────────────────────────────────

  private async applyFetched(): Promise<void> {
    const rows = await this.model().find({ status: 'fetched' }, { orderBy: 'createdAt', order: 'asc' });
    for (const row of rows) {
      try {
        if (await this.applyAnswer(row)) {
          await this.model().update(row.id, { status: 'done', error: '' });
        } else {
          await this.fail(row, 'answer could not be read');
        }
      } catch (err) {
        logger.error(`[MemoryBatchQueue] applying ${row.kind} job ${row.id} failed:`, err);
        await this.fail(row, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** False when the answer cannot be read. Safe to repeat: whatever it creates is keyed by the job. */
  private async applyAnswer(row: MemoryBatchJob): Promise<boolean> {
    if (row.kind === 'extract') {
      const slots = this.extract.parseExtractOutput(row.answer, row.userId || undefined);
      if (!slots) {
        return false;
      }
      for (const [userId, candidates] of slots) {
        const id = childJobId(row.id, userId);
        if (!(await this.model().findById(id))) {
          const input: ConsolidateInput = { candidates };
          await this.create({ id, kind: 'consolidate', groupId: row.groupId, userId, parentId: row.id, input });
        }
      }
      logger.info(`[MemoryBatchQueue] extract ${row.id} group=${row.groupId} → slots=[${[...slots.keys()].join(',')}]`);
      return true;
    }
    const answer = parseMemoryJson(row.answer, `MemoryBatch:${row.kind}`);
    if (!answer) {
      return false;
    }
    const request = JSON.parse(row.requestJson) as MemoryRequest;
    if (row.kind === 'consolidate') {
      await this.consolidation.applySlotAnswer(row.groupId, row.userId, request, answer, row.id);
    } else {
      await this.review.applyReviewAnswer(row.groupId, row.userId, request, answer, row.id);
    }
    return true;
  }

  // ── submit ─────────────────────────────────────────────────────────────────

  private async submitDue(now: number): Promise<void> {
    const queued = await this.model().find({ status: 'queued' }, { orderBy: 'createdAt', order: 'asc' });
    if (queued.length === 0) {
      return;
    }
    if (queued.length < SUBMIT_AT_COUNT && now - queued[0].createdAt.getTime() < SUBMIT_AFTER_MS) {
      return;
    }
    const provider = this.batch.cheapestProvider();
    if (!provider) {
      if (!this.warnedNoProvider) {
        this.warnedNoProvider = true;
        logger.warn('[MemoryBatchQueue] no batch provider is configured (sail / deepinfra); memory jobs stay queued');
      }
      return;
    }

    const prepared: Array<{ row: MemoryBatchJob; request: MemoryRequest }> = [];
    for (const row of await this.pickSubmittable(queued)) {
      const request = await this.prepareRequest(row);
      if (request) {
        prepared.push({ row, request });
      } else {
        await this.model().update(row.id, { status: 'done', error: 'nothing to do' });
      }
    }
    if (prepared.length === 0) {
      return;
    }

    let batchId: string;
    try {
      const job = await this.batch.submitBatch(
        provider,
        prepared.map(({ row, request }) => ({
          customId: row.id,
          prompt: request.prompt,
          options: { ...MEMORY_REQUEST_OPTIONS[row.kind], systemPrompt: request.system },
        })),
      );
      batchId = job.id;
    } catch (err) {
      logger.error(
        `[MemoryBatchQueue] submitting ${prepared.length} jobs to ${provider} failed; they stay queued:`,
        err,
      );
      return;
    }
    for (const { row, request } of prepared) {
      await this.model().update(row.id, {
        status: 'submitted',
        provider,
        batchId,
        submittedAt: now,
        requestJson: JSON.stringify(request),
      });
    }
    logger.info(`[MemoryBatchQueue] submitted ${prepared.length} memory jobs to ${provider} batch ${batchId}`);
  }

  /**
   * Every queued extract, and per slot with nothing in flight one job: its queued
   * consolidations merged into the oldest, else its review.
   */
  private async pickSubmittable(queued: MemoryBatchJob[]): Promise<MemoryBatchJob[]> {
    const busy = new Set((await this.inFlight()).filter((row) => row.kind !== 'extract').map((row) => slotKey(row)));
    const picked: MemoryBatchJob[] = [];
    const bySlot = new Map<string, MemoryBatchJob[]>();
    for (const row of queued) {
      if (row.kind === 'extract') {
        picked.push(row);
      } else if (!busy.has(slotKey(row))) {
        bySlot.set(slotKey(row), [...(bySlot.get(slotKey(row)) ?? []), row]);
      }
    }
    for (const rows of bySlot.values()) {
      const consolidations = rows.filter((row) => row.kind === 'consolidate');
      if (consolidations.length > 0) {
        picked.push(await this.mergeConsolidations(consolidations));
      } else {
        picked.push(rows[0]);
      }
    }
    return picked;
  }

  private async mergeConsolidations([carrier, ...rest]: MemoryBatchJob[]): Promise<MemoryBatchJob> {
    if (rest.length === 0) {
      return carrier;
    }
    const candidates = [carrier, ...rest].flatMap((row) => (JSON.parse(row.inputJson) as ConsolidateInput).candidates);
    const inputJson = JSON.stringify({ candidates } satisfies ConsolidateInput);
    const merged = await this.model().update(carrier.id, { inputJson });
    for (const row of rest) {
      await this.model().update(row.id, { status: 'merged', mergedInto: carrier.id });
    }
    return merged;
  }

  private async prepareRequest(row: MemoryBatchJob): Promise<MemoryRequest | null> {
    if (row.kind === 'extract') {
      const input = JSON.parse(row.inputJson) as ExtractInput;
      return { system: input.system, prompt: input.prompt, factIds: [], dueIds: [] };
    }
    if (row.kind === 'consolidate') {
      const { candidates } = JSON.parse(row.inputJson) as ConsolidateInput;
      return this.consolidation.prepareSlot(row.groupId, row.userId, candidates);
    }
    return this.review.prepareSlotReview(row.groupId, row.userId);
  }

  // ── failure ────────────────────────────────────────────────────────────────

  /** Back to the queue while attempts remain (its request is written afresh), else dropped. */
  private async fail(row: MemoryBatchJob, error: string): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      logger.warn(`[MemoryBatchQueue] ${row.kind} job ${row.id} failed (${error}); queued again`);
      await this.model().update(row.id, {
        status: 'queued',
        attempts,
        error,
        provider: '',
        batchId: '',
        submittedAt: 0,
        requestJson: '',
        answer: '',
      });
    } else {
      logger.warn(
        `[MemoryBatchQueue] ${row.kind} job ${row.id} group=${row.groupId} dropped after ${attempts} attempts: ${error}`,
      );
      await this.model().update(row.id, { status: 'dropped', attempts, error });
    }
  }

  // ── waiting ────────────────────────────────────────────────────────────────

  private handle(id: string): MemoryJobHandle {
    const settled = new Promise<MemoryJobOutcome>((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
    return { id, settled };
  }

  private async settleWaiters(): Promise<void> {
    for (const [id, resolvers] of [...this.waiters]) {
      const outcome = await this.outcomeOf(id);
      if (outcome) {
        this.waiters.delete(id);
        for (const resolve of resolvers) {
          resolve(outcome);
        }
      }
    }
  }

  /** Null while any job of the tree is unfinished. */
  private async outcomeOf(id: string): Promise<MemoryJobOutcome | null> {
    const row = await this.model().findById(id);
    if (!row) {
      return { applied: 0, dropped: 0 };
    }
    const root = await this.followMerges(row);
    if (!FINISHED.has(root.status)) {
      return null;
    }
    const finals = new Map([[root.id, root]]);
    // An extract creates its consolidations before it is marked done, so they all exist by now.
    const children = row.kind === 'extract' ? await this.model().find({ parentId: id }) : [];
    for (const child of children) {
      const last = await this.followMerges(child);
      if (!FINISHED.has(last.status)) {
        return null;
      }
      finals.set(last.id, last);
    }
    const all = [...finals.values()];
    return {
      applied: all.filter((job) => job.status === 'done').length,
      dropped: all.filter((job) => job.status === 'dropped').length,
    };
  }

  private async followMerges(row: MemoryBatchJob): Promise<MemoryBatchJob> {
    let current = row;
    while (current.status === 'merged') {
      const next = await this.model().findById(current.mergedInto);
      if (!next) {
        return { ...current, status: 'dropped' };
      }
      current = next;
    }
    return current;
  }

  // ── storage ────────────────────────────────────────────────────────────────

  private inFlight(): Promise<MemoryBatchJob[]> {
    return Promise.all([...IN_FLIGHT].map((status) => this.model().find({ status }))).then((lists) => lists.flat());
  }

  private async purgeFinished(now: number): Promise<void> {
    for (const status of FINISHED) {
      for (const row of await this.model().find({ status })) {
        if (now - row.updatedAt.getTime() > KEEP_FINISHED_MS && !this.waiters.has(row.id)) {
          await this.model().delete(row.id);
        }
      }
    }
  }

  private create(job: NewJob): Promise<MemoryBatchJob> {
    return this.model().create({
      id: job.id ?? randomUUID(),
      kind: job.kind,
      groupId: job.groupId,
      userId: job.userId,
      parentId: job.parentId,
      status: 'queued',
      mergedInto: '',
      inputJson: JSON.stringify(job.input),
      requestJson: '',
      provider: '',
      batchId: '',
      submittedAt: 0,
      answer: '',
      attempts: 0,
      error: '',
    });
  }

  private model() {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      throw new Error('[MemoryBatchQueue] database is not connected');
    }
    return adapter.getModel('memoryBatchJobs');
  }
}

function slotKey(row: Pick<MemoryBatchJob, 'groupId' | 'userId'>): string {
  return `${row.groupId}/${row.userId}`;
}
