// Batch API module — async/offline LLM processing at ~50% cost.
//
// Supported providers:
// - Anthropic: Direct inline batch via POST /v1/messages/batches
// - Gemini:    Direct inline batch via POST /v1beta/models/{model}:batchGenerateContent
// - Doubao:    TOS-based batch via Volcengine ARK management API
// - DeepInfra: OpenAI-compatible JSONL upload to /files, then POST /batches
// - Sail:      inline Responses API requests via POST /v1/batches (Flex tier)
//
// Usage:
//   import { BatchService } from '@qqbot/llm';
//   const batchService = new BatchService(aiManager);
//   const job = await batchService.submitBatch('anthropic', requests);

export { AnthropicBatchAdapter } from './AnthropicBatchAdapter';
export { type BatchProviderName, BatchService, CHEAPEST_BATCH_PROVIDERS } from './BatchService';
export { DeepInfraBatchAdapter } from './DeepInfraBatchAdapter';
export type { TOSLocation } from './DoubaoBatchAdapter';
export { buildDoubaoJsonlLine, DoubaoBatchAdapter, parseDoubaoBatchOutputLine } from './DoubaoBatchAdapter';
export { GeminiBatchAdapter } from './GeminiBatchAdapter';
export { SailBatchAdapter } from './SailBatchAdapter';
export type {
  BatchAdapter,
  BatchJob,
  BatchJobStatus,
  BatchRequest,
  BatchResult,
  BatchResultStatus,
} from './types';
