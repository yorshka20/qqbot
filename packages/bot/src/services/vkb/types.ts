// TS mirrors of the JSON shapes returned by VKB's
// POST /api/v1/chat/evidence-preview endpoint.
// Upstream Go source: internal/memory/types/types.go (EvidencePack family)
// and internal/server/evidence_qa_handlers.go (response wrapper).

export interface VKBEntityEvidence {
  entity_key: string;
  name: string;
  type: string;
  summary: string;
  definition?: string;
  definition_source?: string;
  definition_score?: number;
  heat_level: number;
  relevance: number;
}

export interface VKBRelationEvidence {
  source_name: string;
  target_name: string;
  relation_type: string;
  description?: string;
  contributing_sources?: string[];
}

export interface VKBCrossVideoEvidence {
  video_bvid: string;
  video_title: string;
  timestamp_start: number;
  timestamp_end: number;
  context: string;
}

export interface VKBInterestTag {
  tag: string;
  weight: number;
}

export interface VKBUserProfileEvidence {
  interest_tags?: VKBInterestTag[];
  recent_topics?: string[];
}

export interface VKBEvidencePack {
  entities?: VKBEntityEvidence[];
  relations?: VKBRelationEvidence[];
  cross_video_context?: VKBCrossVideoEvidence[];
  user_profile?: VKBUserProfileEvidence;
  total_tokens: number;
  token_budget: number;
  provenance?: number[];
}

export interface VKBEvidencePreviewRequest {
  query: string;
  scope?: 'chat_qa' | 'pipeline_enrichment' | 'knowledge_extraction';
  video_bvid?: string;
  detail_level?: string;
  token_budget?: number;
}

export interface VKBEvidencePreviewResponse {
  pack: VKBEvidencePack;
  prompt: {
    system: string;
    user: string;
  };
  took_ms: {
    build_pack: number;
  };
}

/** Response of POST /api/v1/auth/verify. `token` present iff `success`. */
export interface VKBAuthVerifyResponse {
  success: boolean;
  token?: string;
  message?: string;
}
