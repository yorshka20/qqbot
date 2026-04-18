// Batch API types — shared across all provider adapters.

import type { AIGenerateOptions, AIGenerateResponse } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// Request
// ────────────────────────────────────────────────────────────────────────────

/** A single request within a batch. */
export interface BatchRequest {
  /** Caller-supplied unique ID. Used to match results back to requests. */
  customId: string;
  /** Prompt text (or system + user message assembled by caller). */
  prompt: string;
  /** Per-request generation options (temperature, maxTokens, jsonMode, etc.). */
  options?: AIGenerateOptions;
}

// ────────────────────────────────────────────────────────────────────────────
// Job (metadata returned by submit / poll)
// ────────────────────────────────────────────────────────────────────────────

export type BatchJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

/** Metadata for a submitted batch job. */
export interface BatchJob {
  /** Provider-assigned batch ID. */
  id: string;
  /** Provider name (e.g. 'anthropic', 'gemini', 'doubao'). */
  provider: string;
  /** Current status. */
  status: BatchJobStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 completion timestamp (set when status is terminal). */
  completedAt?: string;
  /** Total number of requests in the batch. */
  totalRequests: number;
  /** How many requests succeeded. */
  succeededRequests: number;
  /** How many requests failed. */
  failedRequests: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Result (per-request outcome after batch completes)
// ────────────────────────────────────────────────────────────────────────────

export type BatchResultStatus = 'succeeded' | 'errored' | 'cancelled' | 'expired';

/** Result for a single request within a completed batch. */
export interface BatchResult {
  /** The customId from the original BatchRequest. */
  customId: string;
  /** Outcome of this particular request. */
  status: BatchResultStatus;
  /** LLM response (present when status === 'succeeded'). */
  response?: AIGenerateResponse;
  /** Error message (present when status === 'errored'). */
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter interface (provider-specific implementations)
// ────────────────────────────────────────────────────────────────────────────

/** Each provider adapter implements this interface. */
export interface BatchAdapter {
  /** Human-readable provider name (matches AIProvider.name). */
  readonly providerName: string;

  /** Submit a batch of requests. Returns a job handle for polling. */
  submitBatch(requests: BatchRequest[], model?: string): Promise<BatchJob>;

  /** Poll the status of a previously submitted batch. */
  getBatchStatus(batchId: string): Promise<BatchJob>;

  /** Retrieve results for a completed batch. Throws if batch is not yet complete. */
  getBatchResults(batchId: string): Promise<BatchResult[]>;

  /** Cancel a running batch. No-op if batch is already terminal. */
  cancelBatch(batchId: string): Promise<void>;
}
