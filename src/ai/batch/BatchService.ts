// Batch Service — unified interface for submitting and managing batch LLM jobs.
//
// Supports Anthropic, Gemini, and Doubao batch APIs. Each provider offers ~50%
// cost savings compared to real-time API calls, with a target turnaround of 24 hours.
//
// Usage:
//   const batchService = new BatchService(aiManager);
//   const job = await batchService.submitBatch('anthropic', requests);
//   // ... poll ...
//   const status = await batchService.getBatchStatus('anthropic', job.id);
//   const results = await batchService.getBatchResults('anthropic', job.id);

import { logger } from '@/utils/logger';
import type { AIManager } from '../AIManager';
import { AnthropicBatchAdapter } from './AnthropicBatchAdapter';
import { DoubaoBatchAdapter, type TOSLocation } from './DoubaoBatchAdapter';
import { GeminiBatchAdapter } from './GeminiBatchAdapter';
import type { BatchAdapter, BatchJob, BatchRequest, BatchResult } from './types';

/** Providers that support batch API. */
export type BatchProviderName = 'anthropic' | 'gemini' | 'doubao';

export class BatchService {
  private adapters = new Map<string, BatchAdapter>();

  constructor(private aiManager: AIManager) {}

  /**
   * Submit a batch of requests to a specific provider.
   *
   * @param provider  Provider name ('anthropic', 'gemini', 'doubao').
   * @param requests  Array of BatchRequest to process.
   * @param model     Optional model override.
   * @param tosConfig Required for Doubao only — TOS input/output locations.
   */
  async submitBatch(
    provider: BatchProviderName,
    requests: BatchRequest[],
    model?: string,
    tosConfig?: { input: TOSLocation; output: TOSLocation },
  ): Promise<BatchJob> {
    const adapter = this.getOrCreateAdapter(provider);

    if (provider === 'doubao') {
      return (adapter as DoubaoBatchAdapter).submitBatch(requests, model, tosConfig?.input, tosConfig?.output);
    }

    return adapter.submitBatch(requests, model);
  }

  /**
   * Poll the status of a batch job.
   */
  async getBatchStatus(provider: BatchProviderName, batchId: string): Promise<BatchJob> {
    const adapter = this.getOrCreateAdapter(provider);
    return adapter.getBatchStatus(batchId);
  }

  /**
   * Retrieve results for a completed batch.
   *
   * Note: For Doubao, results are in TOS and must be downloaded externally.
   * This method returns an empty array for Doubao — use the JSONL helpers instead.
   */
  async getBatchResults(provider: BatchProviderName, batchId: string): Promise<BatchResult[]> {
    const adapter = this.getOrCreateAdapter(provider);
    return adapter.getBatchResults(batchId);
  }

  /**
   * Cancel a running batch job.
   */
  async cancelBatch(provider: BatchProviderName, batchId: string): Promise<void> {
    const adapter = this.getOrCreateAdapter(provider);
    return adapter.cancelBatch(batchId);
  }

  /**
   * Convenience: submit and poll until completion.
   * Polls at the given interval (default: 30s). Returns results when done.
   *
   * @param provider    Provider name.
   * @param requests    Batch requests.
   * @param model       Optional model override.
   * @param pollIntervalMs  Polling interval in ms (default: 30000).
   * @param timeoutMs   Max wait time in ms (default: 24 hours).
   * @param onProgress  Optional callback for status updates.
   */
  async submitAndWait(
    provider: BatchProviderName,
    requests: BatchRequest[],
    options?: {
      model?: string;
      pollIntervalMs?: number;
      timeoutMs?: number;
      tosConfig?: { input: TOSLocation; output: TOSLocation };
      onProgress?: (job: BatchJob) => void;
    },
  ): Promise<{ job: BatchJob; results: BatchResult[] }> {
    const pollInterval = options?.pollIntervalMs ?? 30_000;
    const timeout = options?.timeoutMs ?? 24 * 60 * 60 * 1000;
    const startTime = Date.now();

    const job = await this.submitBatch(provider, requests, options?.model, options?.tosConfig);
    logger.info(`[BatchService] Submitted ${provider} batch ${job.id} with ${requests.length} requests`);

    // Poll until terminal state
    let currentJob = job;
    while (Date.now() - startTime < timeout) {
      if (this.isTerminal(currentJob.status)) break;

      await new Promise((r) => setTimeout(r, pollInterval));
      currentJob = await this.getBatchStatus(provider, job.id);
      options?.onProgress?.(currentJob);

      logger.debug(
        `[BatchService] ${provider} batch ${job.id}: ${currentJob.status} (${currentJob.succeededRequests}/${currentJob.totalRequests})`,
      );
    }

    if (!this.isTerminal(currentJob.status)) {
      logger.warn(`[BatchService] ${provider} batch ${job.id} timed out after ${timeout}ms`);
      currentJob = { ...currentJob, status: 'expired' };
    }

    const results = currentJob.status === 'succeeded' ? await this.getBatchResults(provider, job.id) : [];
    return { job: currentJob, results };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private isTerminal(status: string): boolean {
    return ['succeeded', 'failed', 'cancelled', 'expired'].includes(status);
  }

  private getOrCreateAdapter(provider: BatchProviderName): BatchAdapter {
    const cached = this.adapters.get(provider);
    if (cached) return cached;

    const adapter = this.createAdapter(provider);
    this.adapters.set(provider, adapter);
    return adapter;
  }

  /**
   * Create a provider-specific batch adapter by extracting credentials
   * from the registered AIProvider config.
   */
  private createAdapter(provider: BatchProviderName): BatchAdapter {
    switch (provider) {
      case 'anthropic': {
        const config = this.getProviderRawConfig(provider);
        const apiKey = config?.apiKey as string | undefined;
        if (!apiKey) throw new Error(`[BatchService] Anthropic provider not configured or missing apiKey`);
        return new AnthropicBatchAdapter(apiKey);
      }

      case 'gemini': {
        const config = this.getProviderRawConfig(provider);
        // Prefer paid key for batch (more reliable), fall back to free
        const apiKey = (config?.apiKeyPaid as string) || (config?.apiKeyFree as string);
        if (!apiKey) throw new Error(`[BatchService] Gemini provider not configured or missing apiKey`);
        const llmConfig = config?.llm as { model?: string } | undefined;
        return new GeminiBatchAdapter(apiKey, llmConfig?.model);
      }

      case 'doubao': {
        const config = this.getProviderRawConfig(provider);
        const apiKey = config?.apiKey as string | undefined;
        const model = config?.model as string | undefined;
        if (!apiKey || !model) {
          throw new Error(`[BatchService] Doubao provider not configured or missing apiKey/model`);
        }
        return new DoubaoBatchAdapter(apiKey, model, config?.baseURL as string | undefined);
      }

      default:
        throw new Error(`[BatchService] Unsupported batch provider: ${provider}`);
    }
  }

  /**
   * Get raw provider config from AIManager.
   * Provider instances store their original config object; we access it
   * via the private 'config' property common to all concrete providers.
   */
  private getProviderRawConfig(providerName: string): Record<string, unknown> | null {
    const provider = this.aiManager.getProviderForCapability('llm', providerName);
    if (!provider) return null;

    const p = provider as unknown as { config?: Record<string, unknown> };
    return p.config ?? provider.getConfig();
  }
}
