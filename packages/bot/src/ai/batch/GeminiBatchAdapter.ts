// Gemini Batch API adapter (ai.google.dev v1beta).
// Docs: https://ai.google.dev/gemini-api/docs/batch
//
// Key features:
// - Inline requests (up to 20MB) or file-based (up to 2GB JSONL)
// - 50% cost discount
// - Processing target: 24 hours
// - Results inline or via file download

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import type { BatchAdapter, BatchJob, BatchJobStatus, BatchRequest, BatchResult } from './types';

// ────────────────────────────────────────────────────────────────────────────
// Gemini Batch API types (subset)
// ────────────────────────────────────────────────────────────────────────────

interface GeminiInlinedRequest {
  request: {
    contents: Array<{ parts: Array<{ text: string }>; role?: string }>;
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: string;
    };
  };
  metadata: { key: string };
}

interface GeminiBatchCreateBody {
  batch: {
    displayName?: string;
    inputConfig: {
      requests: {
        requests: GeminiInlinedRequest[];
      };
    };
  };
}

type GeminiBatchState =
  | 'BATCH_STATE_UNSPECIFIED'
  | 'BATCH_STATE_PENDING'
  | 'BATCH_STATE_RUNNING'
  | 'BATCH_STATE_SUCCEEDED'
  | 'BATCH_STATE_FAILED'
  | 'BATCH_STATE_CANCELLED'
  | 'BATCH_STATE_EXPIRED';

interface GeminiBatchResponse {
  name: string; // e.g. "batches/abc123"
  displayName?: string;
  state: GeminiBatchState;
  createTime?: string;
  updateTime?: string;
  batchStats?: {
    requestCount?: number;
    successfulRequestCount?: number;
    failedRequestCount?: number;
    pendingRequestCount?: number;
  };
  output?: {
    inlinedResponses?: GeminiInlinedResponse[];
    responsesFile?: string;
  };
}

interface GeminiInlinedResponse {
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  error?: { code?: number; message?: string };
  metadata?: { key?: string };
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiBatchAdapter implements BatchAdapter {
  readonly providerName = 'gemini';
  private httpClient: HttpClient;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.model = model ?? DEFAULT_MODEL;
    this.httpClient = new HttpClient({
      baseURL: `https://generativelanguage.googleapis.com/v1beta`,
      defaultHeaders: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      defaultTimeout: 30_000,
    });
  }

  async submitBatch(requests: BatchRequest[], model?: string): Promise<BatchJob> {
    const resolvedModel = model ?? this.model;

    const inlinedRequests: GeminiInlinedRequest[] = requests.map((req) => ({
      request: {
        contents: [{ parts: [{ text: req.prompt }], role: 'user' }],
        generationConfig: {
          temperature: req.options?.temperature,
          maxOutputTokens: req.options?.maxTokens,
          responseMimeType: req.options?.jsonMode ? 'application/json' : undefined,
        },
      },
      metadata: { key: req.customId },
    }));

    const body: GeminiBatchCreateBody = {
      batch: {
        displayName: `batch-${Date.now()}`,
        inputConfig: {
          requests: { requests: inlinedRequests },
        },
      },
    };

    logger.info(`[GeminiBatch] Submitting batch of ${requests.length} requests (model: ${resolvedModel})`);

    const resp = await this.httpClient.post<GeminiBatchResponse>(`/models/${resolvedModel}:batchGenerateContent`, body);

    return this.toBatchJob(resp, requests.length);
  }

  async getBatchStatus(batchId: string): Promise<BatchJob> {
    const resp = await this.httpClient.get<GeminiBatchResponse>(`/batches/${batchId}`);
    return this.toBatchJob(resp);
  }

  async getBatchResults(batchId: string): Promise<BatchResult[]> {
    const resp = await this.httpClient.get<GeminiBatchResponse>(`/batches/${batchId}`);

    if (!resp.output?.inlinedResponses) {
      // File-based results — would need Files API download. For now, only inline is supported.
      if (resp.output?.responsesFile) {
        throw new Error(
          `[GeminiBatch] File-based results not yet supported. Response file: ${resp.output.responsesFile}`,
        );
      }
      return [];
    }

    const results: BatchResult[] = resp.output.inlinedResponses.map((ir) => {
      if (ir.error) {
        return {
          customId: ir.metadata?.key ?? 'unknown',
          status: 'errored' as const,
          error: ir.error.message ?? `Error code ${ir.error.code}`,
        };
      }

      const candidate = ir.response?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const usage = ir.response?.usageMetadata;

      return {
        customId: ir.metadata?.key ?? 'unknown',
        status: 'succeeded' as const,
        response: {
          text,
          usage: usage
            ? {
                promptTokens: usage.promptTokenCount ?? 0,
                completionTokens: usage.candidatesTokenCount ?? 0,
                totalTokens: usage.totalTokenCount ?? 0,
              }
            : undefined,
          resolvedProviderName: 'gemini',
        },
      };
    });

    logger.info(`[GeminiBatch] Retrieved ${results.length} results for batch ${batchId}`);
    return results;
  }

  async cancelBatch(batchId: string): Promise<void> {
    await this.httpClient.post(`/batches/${batchId}:cancel`);
    logger.info(`[GeminiBatch] Cancelled batch ${batchId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private toBatchJob(resp: GeminiBatchResponse, requestCount?: number): BatchJob {
    const stats = resp.batchStats;
    const total = requestCount ?? stats?.requestCount ?? 0;

    // Extract batch ID from name (e.g. "batches/abc123" → "abc123")
    const parts = resp.name.split('/');
    const id = parts[parts.length - 1] ?? resp.name;

    return {
      id,
      provider: this.providerName,
      status: this.mapState(resp.state),
      createdAt: resp.createTime ?? new Date().toISOString(),
      completedAt: resp.state === 'BATCH_STATE_SUCCEEDED' ? resp.updateTime : undefined,
      totalRequests: total,
      succeededRequests: stats?.successfulRequestCount ?? 0,
      failedRequests: stats?.failedRequestCount ?? 0,
    };
  }

  private mapState(state: GeminiBatchState): BatchJobStatus {
    switch (state) {
      case 'BATCH_STATE_PENDING':
        return 'pending';
      case 'BATCH_STATE_RUNNING':
        return 'processing';
      case 'BATCH_STATE_SUCCEEDED':
        return 'succeeded';
      case 'BATCH_STATE_FAILED':
        return 'failed';
      case 'BATCH_STATE_CANCELLED':
        return 'cancelled';
      case 'BATCH_STATE_EXPIRED':
        return 'expired';
      default:
        return 'pending';
    }
  }
}
