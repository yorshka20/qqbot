// VKB (Video Knowledge Backend) Context Engine integration.
//
// Wraps VKB's POST /api/v1/chat/evidence-preview endpoint to retrieve a
// per-message knowledge pack (entities + relations + cross-video evidence)
// that gets injected into the reply pipeline alongside memory + RAG context.
//
// Distinct from `videoKnowledge` (which submits /analyze and /ingest tasks
// for bilibili video analysis). Both can point at the same VKB instance;
// they cover different endpoint surfaces.

/** Scope hint passed to VKB's retrieval — affects which Views contribute. */
export type VKBContextEngineScope = 'chat_qa' | 'pipeline_enrichment' | 'knowledge_extraction';

export interface VKBContextEngineConfig {
  /** Master switch. When false, the service is registered as a no-op. */
  enabled: boolean;
  /** Base URL of the VKB server (e.g. "http://localhost:8080"). */
  baseURL: string;
  /**
   * Optional HMAC bearer token issued by POST /api/v1/auth/verify.
   * Omit when VKB runs without `authSecret` configured. 7-day TTL upstream —
   * regenerate manually when expired; no auto-refresh.
   */
  authToken?: string;
  /** Retrieval scope passed to VKB. Default: "chat_qa". */
  scope?: VKBContextEngineScope;
  /**
   * Token budget for VKB to truncate the EvidencePack at.
   * Default: 1200 — smaller than VKB's own default (2500) because this is
   * augmentation context, not the whole prompt. Min 100.
   */
  tokenBudget?: number;
  /**
   * Per-request timeout in milliseconds. Default: 3000.
   * Kept tight because this runs in parallel with memory + RAG on every
   * user message; we'd rather drop the augmentation than block reply.
   */
  timeoutMs?: number;
  /**
   * Drop entities whose `relevance` score is below this threshold when
   * formatting. Default: 0.3. Set 0 to keep everything VKB returns.
   */
  minRelevance?: number;
  /** Max entities to include in the formatted block. Default: 5. */
  maxEntities?: number;
  /** Max relations to include in the formatted block. Default: 5. */
  maxRelations?: number;
  /** Max cross-video evidence items to include. Default: 3. */
  maxCrossVideoEvidence?: number;
}
