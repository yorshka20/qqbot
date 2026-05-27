// VKB Context Engine — per-message glossary + usage retrieval for prompt injection.
//
// Wraps VKB's POST /api/v1/chat/evidence-preview to retrieve, for each
// user message, three chat-LLM-useful signals projected from VKB's
// EvidencePack:
//   1. definition       — what a term/meme/slang means
//   2. related concepts — what else the LLM might naturally bring in
//   3. usage examples   — how the term is actually phrased in the wild
//                         (real example sentences, stripped of all
//                         VKB-side metadata like video provenance / heat)
//
// Rendered into a <glossary> block alongside <memory_context> /
// <rag_context>. VKB-internal vocabulary (entity / relation / video /
// bvid / timestamp / heat / relevance) never reaches the LLM — qqbot
// lives in a pure-chat domain that has no notion of those.
//
// Distinct from `videoKnowledge` (which submits /analyze + /ingest tasks
// for bilibili video analysis). Both can point at the same VKB instance;
// they cover different endpoint surfaces with different consumers.

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
   * Max glossary terms to include (top-N by VKB's relevance score). The
   * service does NOT apply a relevance floor — the score is rendered into
   * each term line and the LLM decides what to do with low-scored items.
   * Default: 5.
   */
  maxTerms?: number;
  /** Per-term definition character cap. Default: 200. */
  maxTermLen?: number;
  /**
   * Max related-concept names attached inline to each term. Default: 3.
   * Set 0 to suppress the `[相关: ...]` hint entirely.
   */
  maxRelatedPerTerm?: number;
  /**
   * Max real-world usage example sentences listed below the term block.
   * Default: 3. Set 0 to suppress the `使用示例` section.
   */
  maxUsageExamples?: number;
  /** Per-example character cap. Default: 80. */
  maxExampleLen?: number;
}
