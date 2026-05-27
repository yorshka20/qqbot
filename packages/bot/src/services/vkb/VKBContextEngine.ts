// VKB Context Engine — per-message glossary + usage retrieval for prompt injection.
//
// Calls VKB's POST /api/v1/chat/evidence-preview, then projects the returned
// EvidencePack into three chat-LLM-useful signals — never leaking VKB's
// internal schema (entity types / video provenance / heat scores / etc.):
//
//   1. definition       — what the term means (entity.definition / summary)
//   2. related concepts — what else the LLM might naturally weave in
//                         (relation graph reduced to a flat "[相关: A, B]" hint)
//   3. usage examples   — how the term is actually used in the wild
//                         (cross_video_context.context strings, stripped of
//                          all video metadata — they're just example sentences)
//
// The combination lets the LLM understand the term (def), thread between
// related concepts (relations), and match the right register / phrasing
// (usage). Words like "entity" / "relation" / "video" / "bvid" never
// appear in the rendered block — the qqbot LLM lives in a pure-chat
// domain that has no such concepts.
//
// Fails soft: any error / disabled state / empty query → empty string.

import { injectable } from 'tsyringe';
import { HttpClient } from '@/api/http/HttpClient';
import type { VKBContextEngineConfig } from '@/core/config/types/vkbContextEngine';
import { logger } from '@/utils/logger';
import type {
  VKBEntityEvidence,
  VKBEvidencePack,
  VKBEvidencePreviewRequest,
  VKBEvidencePreviewResponse,
  VKBRelationEvidence,
} from './types';

const LOG_TAG = '[VKBContextEngine]';

const DEFAULT_SCOPE = 'chat_qa' as const;
const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_TERMS = 5;
const DEFAULT_MAX_TERM_LEN = 200;
const DEFAULT_MAX_RELATED_PER_TERM = 3;
const DEFAULT_MAX_USAGE_EXAMPLES = 3;
const DEFAULT_MAX_EXAMPLE_LEN = 80;

@injectable()
export class VKBContextEngine {
  private readonly httpClient: HttpClient;
  private readonly enabled: boolean;
  private readonly scope: VKBContextEngineConfig['scope'];
  private readonly tokenBudget: number;
  private readonly timeoutMs: number;
  private readonly maxTerms: number;
  private readonly maxTermLen: number;
  private readonly maxRelatedPerTerm: number;
  private readonly maxUsageExamples: number;
  private readonly maxExampleLen: number;

  constructor(config: VKBContextEngineConfig) {
    this.enabled = config.enabled;
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTerms = config.maxTerms ?? DEFAULT_MAX_TERMS;
    this.maxTermLen = config.maxTermLen ?? DEFAULT_MAX_TERM_LEN;
    this.maxRelatedPerTerm = config.maxRelatedPerTerm ?? DEFAULT_MAX_RELATED_PER_TERM;
    this.maxUsageExamples = config.maxUsageExamples ?? DEFAULT_MAX_USAGE_EXAMPLES;
    this.maxExampleLen = config.maxExampleLen ?? DEFAULT_MAX_EXAMPLE_LEN;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.authToken) {
      headers.Authorization = `Bearer ${config.authToken}`;
    }

    this.httpClient = new HttpClient({
      baseURL: config.baseURL,
      defaultHeaders: headers,
      defaultTimeout: this.timeoutMs,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * GET /api/v1/health — used at bootstrap to surface mis-config early.
   * Returns false on any failure; never throws.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await this.httpClient.get<{ status: string }>('/api/v1/health');
      return res.status === 'ok';
    } catch (err) {
      logger.warn(`${LOG_TAG} Health check failed:`, err);
      return false;
    }
  }

  /**
   * Fetch a glossary block (definitions + related concepts + usage examples)
   * for terms / memes / slang that may appear in the user's message.
   * Empty string on any failure / disabled state / empty query / no matches.
   */
  async fetchGlossary(query: string): Promise<string> {
    if (!this.enabled) return '';
    const trimmed = query?.trim();
    if (!trimmed) return '';

    const body: VKBEvidencePreviewRequest = {
      query: trimmed,
      scope: this.scope,
      token_budget: this.tokenBudget,
    };

    let response: VKBEvidencePreviewResponse;
    try {
      response = await this.httpClient.post<VKBEvidencePreviewResponse>('/api/v1/chat/evidence-preview', body);
    } catch (err) {
      logger.warn(`${LOG_TAG} evidence-preview failed for query="${truncate(trimmed, 80)}":`, err);
      return '';
    }

    return this.formatGlossary(response.pack);
  }

  /**
   * Project an EvidencePack into the glossary text block. Public so tests
   * (and callers that already hold a pack) can render without re-fetching.
   */
  formatGlossary(pack: VKBEvidencePack): string {
    if (!pack) return '';

    // No qqbot-side relevance filtering — relevance is rendered into the
    // term line so the LLM can weigh each term itself (high score = treat
    // as factual reference; low score = treat as tentative / ignorable).
    // We only cap by maxTerms to keep the token budget bounded; sort
    // descending so the top-N is the highest-relevance subset.
    const terms = [...(pack.entities ?? [])]
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, this.maxTerms);
    if (terms.length === 0) return '';

    const relatedByTerm = this.buildRelatedIndex(terms, pack.relations ?? []);
    const termLines = terms
      .map((e) => this.renderTerm(e, relatedByTerm.get(e.name) ?? []))
      .filter((line): line is string => line !== null);
    if (termLines.length === 0) return '';

    const usageLines = this.renderUsageExamples(pack.cross_video_context ?? []);

    if (usageLines.length === 0) {
      return termLines.join('\n');
    }
    return `${termLines.join('\n')}\n\n使用示例:\n${usageLines.join('\n')}`;
  }

  /**
   * For each shown term, collect distinct "other-side" names from any
   * relation edge touching that term, capped per `maxRelatedPerTerm`.
   * Relation type / description are intentionally dropped — they're VKB
   * taxonomy that adds tokens without buying chat-LLM comprehension.
   */
  private buildRelatedIndex(terms: VKBEntityEvidence[], relations: VKBRelationEvidence[]): Map<string, string[]> {
    const termNames = new Set(terms.map((e) => e.name?.trim()).filter((n): n is string => !!n));
    const index = new Map<string, Set<string>>();
    for (const r of relations) {
      const src = r.source_name?.trim();
      const tgt = r.target_name?.trim();
      if (!src || !tgt || src === tgt) continue;
      if (termNames.has(src)) {
        if (!index.has(src)) index.set(src, new Set());
        index.get(src)?.add(tgt);
      }
      if (termNames.has(tgt)) {
        if (!index.has(tgt)) index.set(tgt, new Set());
        index.get(tgt)?.add(src);
      }
    }
    const out = new Map<string, string[]>();
    for (const [name, others] of index) {
      out.set(name, [...others].slice(0, this.maxRelatedPerTerm));
    }
    return out;
  }

  /**
   * `- name [0.42]: definition [相关: A, B, C]` — relevance always shown
   * so the LLM can judge confidence; related block omitted when empty.
   * Returns null when neither definition nor summary yields usable text.
   */
  private renderTerm(e: VKBEntityEvidence, related: string[]): string | null {
    const name = e.name?.trim();
    if (!name) return null;
    const gloss = (e.definition?.trim() || e.summary?.trim() || '').replace(/\s+/g, ' ');
    if (!gloss) return null;
    const score = (e.relevance ?? 0).toFixed(2);
    const base = `- ${name} [${score}]: ${truncate(gloss, this.maxTermLen)}`;
    if (related.length === 0) return base;
    return `${base} [相关: ${related.join(', ')}]`;
  }

  /**
   * Extract just the natural-language `context` field from VKB's
   * cross_video_context items — these are real example sentences containing
   * the term as used in the wild. Drop everything else (bvid, title,
   * timestamps): the qqbot LLM has no video domain to anchor those to.
   */
  private renderUsageExamples(crossVideo: VKBEvidencePack['cross_video_context']): string[] {
    if (!crossVideo?.length) return [];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of crossVideo) {
      const text = c.context?.trim().replace(/\s+/g, ' ');
      if (!text) continue;
      const truncated = truncate(text, this.maxExampleLen);
      if (seen.has(truncated)) continue;
      seen.add(truncated);
      lines.push(`"${truncated}"`);
      if (lines.length >= this.maxUsageExamples) break;
    }
    return lines;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
