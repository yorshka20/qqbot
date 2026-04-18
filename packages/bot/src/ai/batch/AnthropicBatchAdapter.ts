// Anthropic Message Batches API adapter.
// Docs: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
//
// Key features:
// - Up to 100,000 requests per batch
// - 50% cost discount on both input and output tokens
// - Results available for 29 days
// - Processing target: 24 hours (usually < 1 hour)

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import type { BatchAdapter, BatchJob, BatchJobStatus, BatchRequest, BatchResult } from './types';

// ────────────────────────────────────────────────────────────────────────────
// Anthropic API types (subset)
// ────────────────────────────────────────────────────────────────────────────

interface AnthropicBatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    system?: string;
  };
}

interface AnthropicBatchResponse {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  created_at: string;
  ended_at: string | null;
  expires_at: string;
  results_url: string | null;
}

interface AnthropicBatchResultLine {
  custom_id: string;
  result:
    | {
        type: 'succeeded';
        message: {
          id: string;
          role: 'assistant';
          model: string;
          content: Array<{ type: 'text'; text: string }>;
          stop_reason: string;
          usage: { input_tokens: number; output_tokens: number };
        };
      }
    | { type: 'errored'; error: { type: string; error: { type: string; message: string } } }
    | { type: 'canceled' }
    | { type: 'expired' };
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export class AnthropicBatchAdapter implements BatchAdapter {
  readonly providerName = 'anthropic';
  private httpClient: HttpClient;

  constructor(apiKey: string) {
    this.httpClient = new HttpClient({
      baseURL: 'https://api.anthropic.com/v1',
      defaultHeaders: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      defaultTimeout: 30_000,
    });
  }

  async submitBatch(requests: BatchRequest[], model?: string): Promise<BatchJob> {
    const resolvedModel = model ?? DEFAULT_MODEL;

    const apiRequests: AnthropicBatchRequest[] = requests.map((req) => ({
      custom_id: req.customId,
      params: {
        model: req.options?.model ?? resolvedModel,
        max_tokens: req.options?.maxTokens ?? 2048,
        temperature: req.options?.temperature,
        messages: [{ role: 'user', content: req.prompt }],
      },
    }));

    logger.info(`[AnthropicBatch] Submitting batch of ${requests.length} requests (model: ${resolvedModel})`);

    const resp = await this.httpClient.post<AnthropicBatchResponse>('/messages/batches', {
      requests: apiRequests,
    });

    return this.toBatchJob(resp);
  }

  async getBatchStatus(batchId: string): Promise<BatchJob> {
    const resp = await this.httpClient.get<AnthropicBatchResponse>(`/messages/batches/${batchId}`);
    return this.toBatchJob(resp);
  }

  async getBatchResults(batchId: string): Promise<BatchResult[]> {
    // Results endpoint returns JSONL (newline-delimited JSON)
    const stream = await this.httpClient.stream(`/messages/batches/${batchId}/results`, {
      method: 'GET',
    });

    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';
    const results: BatchResult[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as AnthropicBatchResultLine;
          results.push(this.toResult(parsed));
        } catch {
          logger.warn(`[AnthropicBatch] Failed to parse result line: ${trimmed.slice(0, 100)}`);
        }
      }
    }

    // Parse any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim()) as AnthropicBatchResultLine;
        results.push(this.toResult(parsed));
      } catch {
        // ignore trailing partial
      }
    }

    logger.info(`[AnthropicBatch] Retrieved ${results.length} results for batch ${batchId}`);
    return results;
  }

  async cancelBatch(batchId: string): Promise<void> {
    await this.httpClient.post(`/messages/batches/${batchId}/cancel`);
    logger.info(`[AnthropicBatch] Cancelled batch ${batchId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private toBatchJob(resp: AnthropicBatchResponse): BatchJob {
    const counts = resp.request_counts;
    const total = counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired;

    return {
      id: resp.id,
      provider: this.providerName,
      status: this.mapStatus(resp.processing_status, counts),
      createdAt: resp.created_at,
      completedAt: resp.ended_at ?? undefined,
      totalRequests: total,
      succeededRequests: counts.succeeded,
      failedRequests: counts.errored,
    };
  }

  private mapStatus(
    apiStatus: AnthropicBatchResponse['processing_status'],
    counts: AnthropicBatchResponse['request_counts'],
  ): BatchJobStatus {
    if (apiStatus === 'in_progress') return 'processing';
    if (apiStatus === 'canceling') return 'processing';
    // ended — determine final status from counts
    if (counts.canceled > 0 && counts.succeeded === 0) return 'cancelled';
    if (counts.expired > 0 && counts.succeeded === 0) return 'expired';
    if (counts.errored > 0 && counts.succeeded === 0) return 'failed';
    return 'succeeded';
  }

  private toResult(line: AnthropicBatchResultLine): BatchResult {
    switch (line.result.type) {
      case 'succeeded': {
        const msg = line.result.message;
        const text = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');
        return {
          customId: line.custom_id,
          status: 'succeeded',
          response: {
            text,
            usage: {
              promptTokens: msg.usage.input_tokens,
              completionTokens: msg.usage.output_tokens,
              totalTokens: msg.usage.input_tokens + msg.usage.output_tokens,
            },
            resolvedProviderName: 'anthropic',
          },
        };
      }
      case 'errored':
        return {
          customId: line.custom_id,
          status: 'errored',
          error: line.result.error.error.message,
        };
      case 'canceled':
        return { customId: line.custom_id, status: 'cancelled' };
      case 'expired':
        return { customId: line.custom_id, status: 'expired' };
    }
  }
}
