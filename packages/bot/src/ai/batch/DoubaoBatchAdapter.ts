// Doubao / Volcengine ARK Batch Inference adapter.
// Docs: https://www.volcengine.com/docs/82379/1305505
//
// Key features:
// - 50% cost discount (Doubao 1.5+ series)
// - Input via JSONL file uploaded to Volcengine TOS (object storage)
// - Max 500 batch jobs per project per 7 days, max 3 concurrent
// - Max input file size: 500 MiB (8 GiB with support request)
//
// NOTE: This adapter handles the job management API (create/poll/cancel).
// File upload to TOS must be done externally before calling submitBatch.
// The caller is responsible for:
//   1. Building the JSONL file (see buildJsonlLine helper)
//   2. Uploading it to a TOS bucket
//   3. Passing the TOS location to submitBatch

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import type { AIGenerateOptions } from '../types';
import type { BatchAdapter, BatchJob, BatchJobStatus, BatchRequest, BatchResult } from './types';

// ────────────────────────────────────────────────────────────────────────────
// Volcengine Batch API types
// ────────────────────────────────────────────────────────────────────────────

/** TOS (object storage) file location for batch input/output. */
export interface TOSLocation {
  /** TOS bucket name. */
  bucketName: string;
  /** Object key (path within bucket). */
  objectKey: string;
  /** Optional: TOS region endpoint. */
  endpoint?: string;
}

interface DoubaoCreateBatchJobRequest {
  Name: string;
  ModelReference: string;
  InputFileTosLocation: TOSLocation;
  OutputDirTosLocation: TOSLocation;
  CompletionWindow?: string; // e.g. "24h"
}

type DoubaoBatchJobStatus = 'Running' | 'Completed' | 'Failed' | 'Cancelled' | 'Expired' | 'Validating' | 'Queued';

interface DoubaoBatchJobResponse {
  Id: string;
  Name: string;
  Status: DoubaoBatchJobStatus;
  ModelReference: string;
  InputFileTosLocation: TOSLocation;
  OutputDirTosLocation: TOSLocation;
  CreatedAt: string;
  CompletedAt?: string;
  RequestCounts?: {
    Total: number;
    Succeeded: number;
    Failed: number;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

export class DoubaoBatchAdapter implements BatchAdapter {
  readonly providerName = 'doubao';
  private httpClient: HttpClient;
  private model: string;

  /**
   * @param apiKey Volcengine ARK API key (Bearer token).
   * @param model  Default model/endpoint ID for batch jobs.
   * @param baseURL ARK API base URL (default: https://ark.cn-beijing.volces.com/api/v3).
   */
  constructor(apiKey: string, model: string, baseURL?: string) {
    this.model = model;
    this.httpClient = new HttpClient({
      baseURL: baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3',
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      defaultTimeout: 30_000,
    });
  }

  /**
   * Submit a batch job.
   *
   * **IMPORTANT**: Unlike Anthropic/Gemini, Doubao requires the input JSONL file
   * to be pre-uploaded to Volcengine TOS. The `requests` parameter is used to
   * determine request count only. The actual input must be uploaded separately.
   *
   * @param requests Used for request count metadata only.
   * @param model Model or endpoint ID override.
   * @param tosInput TOS location of the uploaded JSONL input file.
   * @param tosOutput TOS location for output.
   */
  async submitBatch(
    requests: BatchRequest[],
    model?: string,
    tosInput?: TOSLocation,
    tosOutput?: TOSLocation,
  ): Promise<BatchJob> {
    if (!tosInput || !tosOutput) {
      throw new Error(
        '[DoubaoBatch] TOS input and output locations are required. ' +
          'Upload the JSONL file to TOS first, then pass the locations here.',
      );
    }

    const resolvedModel = model ?? this.model;
    const jobName = `batch-${Date.now()}`;

    logger.info(
      `[DoubaoBatch] Submitting batch job "${jobName}" with ${requests.length} requests (model: ${resolvedModel})`,
    );

    const body: DoubaoCreateBatchJobRequest = {
      Name: jobName,
      ModelReference: resolvedModel,
      InputFileTosLocation: tosInput,
      OutputDirTosLocation: tosOutput,
      CompletionWindow: '24h',
    };

    const resp = await this.httpClient.post<DoubaoBatchJobResponse>('/batch/jobs', body);

    return this.toBatchJob(resp, requests.length);
  }

  async getBatchStatus(batchId: string): Promise<BatchJob> {
    const resp = await this.httpClient.get<DoubaoBatchJobResponse>(`/batch/jobs/${batchId}`);
    return this.toBatchJob(resp);
  }

  /**
   * Retrieve batch results.
   *
   * NOTE: Doubao writes results to TOS as JSONL. This method cannot directly
   * retrieve them — the caller must download from the output TOS location
   * specified when creating the job.
   *
   * This method returns an empty array and logs a warning with the output location.
   * Use `parseTosOutputLine()` to parse individual JSONL lines from the downloaded file.
   */
  async getBatchResults(batchId: string): Promise<BatchResult[]> {
    const job = await this.httpClient.get<DoubaoBatchJobResponse>(`/batch/jobs/${batchId}`);

    logger.warn(
      `[DoubaoBatch] Results are stored in TOS: bucket="${job.OutputDirTosLocation.bucketName}", ` +
        `key="${job.OutputDirTosLocation.objectKey}". Download and parse them externally.`,
    );

    return [];
  }

  async cancelBatch(batchId: string): Promise<void> {
    await this.httpClient.post(`/batch/jobs/${batchId}/cancel`);
    logger.info(`[DoubaoBatch] Cancelled batch ${batchId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private toBatchJob(resp: DoubaoBatchJobResponse, requestCount?: number): BatchJob {
    return {
      id: resp.Id,
      provider: this.providerName,
      status: this.mapStatus(resp.Status),
      createdAt: resp.CreatedAt,
      completedAt: resp.CompletedAt,
      totalRequests: requestCount ?? resp.RequestCounts?.Total ?? 0,
      succeededRequests: resp.RequestCounts?.Succeeded ?? 0,
      failedRequests: resp.RequestCounts?.Failed ?? 0,
    };
  }

  private mapStatus(status: DoubaoBatchJobStatus): BatchJobStatus {
    switch (status) {
      case 'Running':
      case 'Validating':
      case 'Queued':
        return 'processing';
      case 'Completed':
        return 'succeeded';
      case 'Failed':
        return 'failed';
      case 'Cancelled':
        return 'cancelled';
      case 'Expired':
        return 'expired';
      default:
        return 'pending';
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// JSONL Helpers (for building Doubao batch input files)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a single JSONL line for Doubao batch input.
 * Each line follows the format: {"custom_id": "...", "body": {"messages": [...], ...}}
 */
export function buildDoubaoJsonlLine(customId: string, prompt: string, options?: AIGenerateOptions): string {
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: options?.maxTokens ?? 2048,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.model) body.model = options.model;

  return JSON.stringify({ custom_id: customId, body });
}

/**
 * Parse a single JSONL line from Doubao batch output.
 * Returns a BatchResult.
 */
export function parseDoubaoBatchOutputLine(line: string): BatchResult | null {
  try {
    const parsed = JSON.parse(line) as {
      custom_id: string;
      response?: {
        status_code: number;
        body?: {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
      };
      error?: { message: string };
    };

    if (parsed.error) {
      return { customId: parsed.custom_id, status: 'errored', error: parsed.error.message };
    }

    const body = parsed.response?.body;
    const text = body?.choices?.[0]?.message?.content ?? '';
    const usage = body?.usage;

    return {
      customId: parsed.custom_id,
      status: 'succeeded',
      response: {
        text,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens ?? 0,
            }
          : undefined,
        resolvedProviderName: 'doubao',
      },
    };
  } catch {
    return null;
  }
}
