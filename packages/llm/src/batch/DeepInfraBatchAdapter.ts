// DeepInfra Batch API adapter (OpenAI-compatible files + batches).
// Docs: https://docs.deepinfra.com/batch/introduction
//
// - 20% below the real-time price of the same model, and outside the real-time rate limits
// - Input is a JSONL file uploaded to /files (purpose "batch"); one model per file
// - Up to 50,000 lines / 200 MB per file, 100 concurrent batches per user
// - completion_window is always "24h"; an expired batch still writes the requests it finished

import { HttpClient, logger } from '@qqbot/shared';
import type { DeepInfraProvider } from '../providers/DeepInfraProvider';
import type { ChatCompletion } from '../providers/DeepSeekChatProvider';
import type { BatchAdapter, BatchJob, BatchJobStatus, BatchRequest, BatchResult } from './types';

const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions';
const MAX_REQUESTS_PER_FILE = 50_000;

type DeepInfraBatchStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

interface DeepInfraBatch {
  id: string;
  status: DeepInfraBatchStatus;
  model?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  created_at: number;
  completed_at?: number | null;
  failed_at?: number | null;
  expired_at?: number | null;
  cancelled_at?: number | null;
  request_counts?: { total: number; completed: number; failed: number };
  errors?: { data?: Array<{ code?: string; message?: string; line?: number }> } | null;
}

interface DeepInfraBatchOutputLine {
  custom_id: string;
  response: { status_code: number; body: ChatCompletion | { error?: { message?: string } } } | null;
  error: { code?: string; message?: string } | null;
}

export class DeepInfraBatchAdapter implements BatchAdapter {
  readonly providerName: string;
  private httpClient: HttpClient;

  /**
   * @param provider The configured chat provider. Request lines are built and results parsed
   *                 through it, so a batched request is byte-for-byte the request a live call sends.
   */
  constructor(
    private readonly provider: DeepInfraProvider,
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

  /** Every line runs on one model: the batch's, or the provider's configured model. */
  async submitBatch(requests: BatchRequest[], model?: string): Promise<BatchJob> {
    if (requests.length === 0) {
      throw new Error('[DeepInfraBatch] A batch needs at least one request');
    }
    if (requests.length > MAX_REQUESTS_PER_FILE) {
      throw new Error(
        `[DeepInfraBatch] ${requests.length} requests exceed the ${MAX_REQUESTS_PER_FILE}-line file limit`,
      );
    }
    const resolvedModel = model ?? this.provider.getDefaultModel();
    const jsonl = requests.map((request) => this.toJsonlLine(request, resolvedModel)).join('\n');

    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');
    const file = await this.httpClient.post<{ id: string }>('/files', form);

    logger.info(
      `[DeepInfraBatch] Submitting ${requests.length} requests (model: ${resolvedModel}, input file ${file.id})`,
    );
    const batch = await this.httpClient.post<DeepInfraBatch>('/batches', {
      input_file_id: file.id,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
      completion_window: '24h',
    });
    return this.toBatchJob(batch, requests.length);
  }

  async getBatchStatus(batchId: string): Promise<BatchJob> {
    return this.toBatchJob(await this.getBatch(batchId));
  }

  /**
   * Results of every request the batch finished, from its output and error files. A batch
   * that expired or was cancelled still has results for what it finished.
   */
  async getBatchResults(batchId: string): Promise<BatchResult[]> {
    const batch = await this.getBatch(batchId);
    if (!['completed', 'expired', 'cancelled'].includes(batch.status)) {
      throw new Error(`[DeepInfraBatch] Batch ${batchId} is ${batch.status}; results exist once it has ended`);
    }

    const results: BatchResult[] = [];
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) {
        continue;
      }
      const content = await this.httpClient.get<string | ArrayBuffer>(`/files/${fileId}/content`);
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      for (const line of text.split('\n')) {
        if (line.trim()) {
          results.push(this.parseOutputLine(JSON.parse(line) as DeepInfraBatchOutputLine, batch.model));
        }
      }
    }
    return results;
  }

  async cancelBatch(batchId: string): Promise<void> {
    await this.httpClient.post(`/batches/${batchId}/cancel`);
    logger.info(`[DeepInfraBatch] Cancelled batch ${batchId}`);
  }

  private toJsonlLine(request: BatchRequest, model: string): string {
    if (request.options?.model && request.options.model !== model) {
      throw new Error(
        `[DeepInfraBatch] Request ${request.customId} asks for ${request.options.model}; a batch runs one model (${model})`,
      );
    }
    const body = this.provider.buildChatCompletionBody(request.prompt, { ...request.options, model });
    return JSON.stringify({ custom_id: request.customId, method: 'POST', url: CHAT_COMPLETIONS_ENDPOINT, body });
  }

  private parseOutputLine(line: DeepInfraBatchOutputLine, batchModel: string | undefined): BatchResult {
    if (line.error || !line.response) {
      return {
        customId: line.custom_id,
        status: line.error?.code === 'cancelled' ? 'cancelled' : 'errored',
        error: line.error?.message ?? line.error?.code ?? 'no response',
      };
    }
    const { status_code, body } = line.response;
    if (status_code !== 200 || !('choices' in body)) {
      const message = 'error' in body ? body.error?.message : undefined;
      return { customId: line.custom_id, status: 'errored', error: `HTTP ${status_code}: ${message ?? 'no detail'}` };
    }
    try {
      const response = this.provider.parseChatCompletion(body, batchModel ?? body.model);
      return {
        customId: line.custom_id,
        status: 'succeeded',
        response: { ...response, resolvedProviderName: this.providerName },
      };
    } catch (error) {
      return {
        customId: line.custom_id,
        status: 'errored',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getBatch(batchId: string): Promise<DeepInfraBatch> {
    return this.httpClient.get<DeepInfraBatch>(`/batches/${batchId}`);
  }

  private toBatchJob(batch: DeepInfraBatch, requestCount?: number): BatchJob {
    const endedAt = batch.completed_at ?? batch.failed_at ?? batch.expired_at ?? batch.cancelled_at;
    if (batch.status === 'failed') {
      const reasons = batch.errors?.data?.map((e) => `${e.line !== undefined ? `line ${e.line}: ` : ''}${e.message}`);
      logger.warn(`[DeepInfraBatch] Batch ${batch.id} failed validation: ${reasons?.join('; ') ?? 'no detail'}`);
    }
    return {
      id: batch.id,
      provider: this.providerName,
      status: DeepInfraBatchAdapter.mapStatus(batch.status),
      createdAt: new Date(batch.created_at * 1000).toISOString(),
      completedAt: endedAt ? new Date(endedAt * 1000).toISOString() : undefined,
      totalRequests: batch.request_counts?.total || requestCount || 0,
      succeededRequests: batch.request_counts?.completed ?? 0,
      failedRequests: batch.request_counts?.failed ?? 0,
    };
  }

  private static mapStatus(status: DeepInfraBatchStatus): BatchJobStatus {
    switch (status) {
      case 'validating':
        return 'pending';
      case 'in_progress':
      case 'finalizing':
      case 'cancelling':
        return 'processing';
      case 'completed':
        return 'succeeded';
      case 'failed':
        return 'failed';
      case 'expired':
        return 'expired';
      case 'cancelled':
        return 'cancelled';
    }
  }
}
