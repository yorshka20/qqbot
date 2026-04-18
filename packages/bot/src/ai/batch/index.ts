// Batch API module — async/offline LLM processing at ~50% cost.
//
// Supported providers:
// - Anthropic: Direct inline batch via POST /v1/messages/batches
// - Gemini:    Direct inline batch via POST /v1beta/models/{model}:batchGenerateContent
// - Doubao:    TOS-based batch via Volcengine ARK management API
//
// Usage:
//   import { BatchService } from '@/ai/batch';
//   const batchService = new BatchService(aiManager);
//   const job = await batchService.submitBatch('anthropic', requests);

export { AnthropicBatchAdapter } from './AnthropicBatchAdapter';
export { type BatchProviderName, BatchService } from './BatchService';
export type { TOSLocation } from './DoubaoBatchAdapter';
export { buildDoubaoJsonlLine, DoubaoBatchAdapter, parseDoubaoBatchOutputLine } from './DoubaoBatchAdapter';
export { GeminiBatchAdapter } from './GeminiBatchAdapter';
export type {
  BatchAdapter,
  BatchJob,
  BatchJobStatus,
  BatchRequest,
  BatchResult,
  BatchResultStatus,
} from './types';
