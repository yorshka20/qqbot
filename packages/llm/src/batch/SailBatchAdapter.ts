// Sail Research Batch API adapter.
// Docs: https://docs.sailresearch.com/requests_at_scale
//
// - Requests are inline in POST /v1/batches; each is a Responses API body (`/v1/responses` only)
// - Always runs on the Flex tier (the cheapest Sail price); no completion window is promised —
//   Flex guarantees only that a first turn starts within an hour
// - Up to 100,000 requests / 256 MB per batch; results come back inline on GET /v1/batches/{id},
//   or one by one past ~1 GiB, and may expire 10 minutes after first delivery
// - No cancel endpoint is documented

import { HttpClient, logger } from '@qqbot/shared';
import type { SailProvider, SailResponse } from '../providers/SailProvider';
import type { BatchAdapter, BatchJob, BatchRequest, BatchResult } from './types';

const MAX_REQUESTS_PER_BATCH = 100_000;
const CUSTOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type SailRequestStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface SailBatchResultItem {
  custom_id: string;
  response: { status_code: number; body: SailResponse | { error?: { message?: string } } } | null;
  error: { code?: string; message?: string } | null;
}

interface SailBatch {
  id: string;
  status: 'in_progress' | 'completed';
  created_at: number;
  request_counts: { total: number; completed: number; failed: number };
  request_status?: Record<string, { status: SailRequestStatus }>;
  results?: SailBatchResultItem[] | null;
  error?: { code?: string; message?: string } | null;
}

export class SailBatchAdapter implements BatchAdapter {
  readonly providerName: string;
  private httpClient: HttpClient;

  /**
   * @param provider The configured Sail provider; request bodies are built and results parsed through it.
   */
  constructor(
    private readonly provider: SailProvider,
    apiKey: string,
  ) {
    this.providerName = provider.name;
    this.httpClient = new HttpClient({
      baseURL: provider.apiBaseURL,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      defaultTimeout: 120_000,
    });
  }

  /** Every request runs on the batch's model, or the provider's configured model. */
  async submitBatch(requests: BatchRequest[], model?: string): Promise<BatchJob> {
    if (requests.length === 0) {
      throw new Error('[SailBatch] A batch needs at least one request');
    }
    if (requests.length > MAX_REQUESTS_PER_BATCH) {
      throw new Error(`[SailBatch] ${requests.length} requests exceed the ${MAX_REQUESTS_PER_BATCH}-request limit`);
    }
    const resolvedModel = model ?? this.provider.getDefaultModel();
    const items = requests.map((request) => {
      if (!CUSTOM_ID_PATTERN.test(request.customId)) {
        throw new Error(`[SailBatch] custom_id "${request.customId}" must match ${CUSTOM_ID_PATTERN}`);
      }
      return {
        custom_id: request.customId,
        params: this.provider.buildResponsesBody(request.prompt, {
          ...request.options,
          model: request.options?.model ?? resolvedModel,
        }),
      };
    });

    logger.info(`[SailBatch] Submitting ${requests.length} requests (model: ${resolvedModel})`);
    const created = await this.httpClient.post<{ id: string; created_at: number }>('/batches', {
      endpoint: '/v1/responses',
      requests: items,
    });
    return {
      id: created.id,
      provider: this.providerName,
      status: 'processing',
      createdAt: new Date(created.created_at * 1000).toISOString(),
      totalRequests: requests.length,
      succeededRequests: 0,
      failedRequests: 0,
    };
  }

  async getBatchStatus(batchId: string): Promise<BatchJob> {
    return this.toBatchJob(await this.getBatch(batchId));
  }

  /**
   * Results of a completed batch. Past Sail's inline size limit each result is fetched by its
   * custom_id. Sail may expire a result minutes after first delivery, so callers persist what
   * this returns rather than fetching it again.
   */
  async getBatchResults(batchId: string): Promise<BatchResult[]> {
    const batch = await this.getBatch(batchId);
    if (batch.status !== 'completed') {
      throw new Error(`[SailBatch] Batch ${batchId} is ${batch.status}; results exist once it has completed`);
    }

    let items = batch.results;
    if (!items) {
      if (batch.error?.code !== 'batch_results_too_large') {
        throw new Error(`[SailBatch] Batch ${batchId} returned no results: ${batch.error?.message ?? 'no detail'}`);
      }
      items = [];
      for (const customId of Object.keys(batch.request_status ?? {})) {
        items.push(await this.httpClient.get<SailBatchResultItem>(`/batches/${batchId}/${customId}`));
      }
    }
    const statuses = batch.request_status ?? {};
    return items.map((item) => this.toResult(item, statuses[item.custom_id]?.status));
  }

  async cancelBatch(batchId: string): Promise<void> {
    throw new Error(`[SailBatch] Sail has no endpoint to cancel batch ${batchId}`);
  }

  private toResult(item: SailBatchResultItem, requestStatus: SailRequestStatus | undefined): BatchResult {
    if (!item.response) {
      return {
        customId: item.custom_id,
        status: requestStatus === 'CANCELLED' ? 'cancelled' : 'errored',
        error: item.error?.message ?? item.error?.code ?? 'no response',
      };
    }
    const { status_code, body } = item.response;
    if (status_code !== 200 || !('output' in body)) {
      const message = 'error' in body ? body.error?.message : undefined;
      return { customId: item.custom_id, status: 'errored', error: `HTTP ${status_code}: ${message ?? 'no detail'}` };
    }
    try {
      return {
        customId: item.custom_id,
        status: 'succeeded',
        response: this.provider.parseResponsesBody(body, body.model),
      };
    } catch (error) {
      return {
        customId: item.custom_id,
        status: 'errored',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getBatch(batchId: string): Promise<SailBatch> {
    return this.httpClient.get<SailBatch>(`/batches/${batchId}`);
  }

  private toBatchJob(batch: SailBatch): BatchJob {
    return {
      id: batch.id,
      provider: this.providerName,
      status: batch.status === 'completed' ? 'succeeded' : 'processing',
      createdAt: new Date(batch.created_at * 1000).toISOString(),
      totalRequests: batch.request_counts.total,
      succeededRequests: batch.request_counts.completed,
      failedRequests: batch.request_counts.failed,
    };
  }
}
