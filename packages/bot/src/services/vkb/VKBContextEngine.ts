// VKB Context Engine — per-message knowledge retrieval for prompt injection.
//
// Calls VKB's POST /api/v1/chat/evidence-preview, formats the returned
// EvidencePack into a compact text block suitable for inclusion alongside
// memory + RAG context in the reply pipeline's final user message.
//
// Designed to fail soft: any error / disabled state / empty query → empty
// string. Never throws into the pipeline; warn-log + skip.

import { injectable } from 'tsyringe';
import { HttpClient } from '@/api/http/HttpClient';
import type { VKBContextEngineConfig } from '@/core/config/types/vkbContextEngine';
import { logger } from '@/utils/logger';
import type {
  VKBCrossVideoEvidence,
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
const DEFAULT_MIN_RELEVANCE = 0.3;
const DEFAULT_MAX_ENTITIES = 5;
const DEFAULT_MAX_RELATIONS = 5;
const DEFAULT_MAX_CROSS_VIDEO = 3;

@injectable()
export class VKBContextEngine {
  private readonly httpClient: HttpClient;
  private readonly enabled: boolean;
  private readonly scope: VKBContextEngineConfig['scope'];
  private readonly tokenBudget: number;
  private readonly timeoutMs: number;
  private readonly minRelevance: number;
  private readonly maxEntities: number;
  private readonly maxRelations: number;
  private readonly maxCrossVideo: number;

  constructor(config: VKBContextEngineConfig) {
    this.enabled = config.enabled;
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minRelevance = config.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    this.maxEntities = config.maxEntities ?? DEFAULT_MAX_ENTITIES;
    this.maxRelations = config.maxRelations ?? DEFAULT_MAX_RELATIONS;
    this.maxCrossVideo = config.maxCrossVideoEvidence ?? DEFAULT_MAX_CROSS_VIDEO;

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
   * Fetch evidence for a user query and return a pre-formatted text block.
   * Empty string on any failure / disabled state / empty query / no matches —
   * caller injects unconditionally and the assembler skips empty sections.
   */
  async fetchContextText(query: string, opts?: { videoBvid?: string }): Promise<string> {
    if (!this.enabled) return '';
    const trimmed = query?.trim();
    if (!trimmed) return '';

    const body: VKBEvidencePreviewRequest = {
      query: trimmed,
      scope: this.scope,
      token_budget: this.tokenBudget,
    };
    if (opts?.videoBvid) {
      body.video_bvid = opts.videoBvid;
    }

    let response: VKBEvidencePreviewResponse;
    try {
      response = await this.httpClient.post<VKBEvidencePreviewResponse>('/api/v1/chat/evidence-preview', body);
    } catch (err) {
      logger.warn(`${LOG_TAG} evidence-preview failed for query="${truncate(trimmed, 80)}":`, err);
      return '';
    }

    return this.formatPack(response.pack);
  }

  /**
   * Reduce an EvidencePack to a compact, LLM-friendly text block.
   * Public so callers (and tests) can format an already-fetched pack
   * without re-issuing the HTTP request.
   */
  formatPack(pack: VKBEvidencePack): string {
    if (!pack) return '';

    const entities = (pack.entities ?? []).filter((e) => e.relevance >= this.minRelevance).slice(0, this.maxEntities);
    const relations = (pack.relations ?? []).slice(0, this.maxRelations);
    const crossVideo = (pack.cross_video_context ?? []).slice(0, this.maxCrossVideo);

    if (entities.length === 0 && relations.length === 0 && crossVideo.length === 0) {
      return '';
    }

    const lines: string[] = [];

    if (entities.length > 0) {
      lines.push('[相关实体]');
      for (const e of entities) {
        lines.push(formatEntity(e));
      }
    }

    if (relations.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('[实体关系]');
      for (const r of relations) {
        lines.push(formatRelation(r));
      }
    }

    if (crossVideo.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('[相关视频片段]');
      for (const c of crossVideo) {
        lines.push(formatCrossVideo(c));
      }
    }

    return lines.join('\n');
  }
}

function formatEntity(e: VKBEntityEvidence): string {
  const head = `- ${e.name} (${e.type})`;
  const body: string[] = [];
  if (e.definition?.trim()) {
    body.push(`  释义: ${truncate(e.definition.trim(), 200)}`);
  }
  if (e.summary?.trim() && e.summary !== e.definition) {
    body.push(`  用法: ${truncate(e.summary.trim(), 200)}`);
  }
  return [head, ...body].join('\n');
}

function formatRelation(r: VKBRelationEvidence): string {
  const arrow = r.relation_type ? `——(${r.relation_type})——>` : '——>';
  const head = `- ${r.source_name} ${arrow} ${r.target_name}`;
  if (r.description?.trim()) {
    return `${head}\n  ${truncate(r.description.trim(), 150)}`;
  }
  return head;
}

function formatCrossVideo(c: VKBCrossVideoEvidence): string {
  const ts = `${formatTime(c.timestamp_start)}-${formatTime(c.timestamp_end)}`;
  const title = c.video_title?.trim() || c.video_bvid;
  const head = `- [${c.video_bvid}] ${title} @ ${ts}`;
  if (c.context?.trim()) {
    return `${head}\n  ${truncate(c.context.trim(), 150)}`;
  }
  return head;
}

function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
