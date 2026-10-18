// Serper.dev HTTP API client (Google SERP proxy)
//
// Deliberately not `HealthCheckable`: every request to this API is billed, so
// the only probe that would reveal an exhausted or rejected key costs a credit
// to answer a question the next real search answers for free. SearchService
// attempts it directly and falls through to the next configured provider when
// it fails.

import type { SerperConfig } from '@/core/config/types/mcp';
import { logger } from '@/utils/logger';
import type { SearchOptions, SearchResult } from '../searxng/types';
import type { SerperSearchResponse } from './types';

const DEFAULT_ENDPOINT = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 10000;
/** Added to the budget per extra query in a batch (upstream work grows with the batch). */
const BATCH_TIMEOUT_STEP_MS = 2000;

export class SerperClient {
  private apiKey: string;
  private endpoint: string;
  private glOverride?: string;
  private hlOverride?: string;
  private timeoutMs: number;

  constructor(config: SerperConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint?.replace(/\/$/, '') || DEFAULT_ENDPOINT;
    this.glOverride = config.gl;
    this.hlOverride = config.hl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Execute web search via Serper.dev (Google SERP).
   * Serper is Google-only — `engines` / `categories` options are ignored.
   */
  async webSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const [results] = await this.webSearchBatch([query], options);
    return results ?? [];
  }

  /**
   * Run several queries in **one** request. Serper accepts an array body and
   * answers with an array in the same order, billing each query exactly as if it
   * had been sent alone — so N queries cost N credits either way, but batched
   * they cost one round trip and one timeout instead of N.
   *
   * Independent sub-questions should therefore always come through here: serial
   * searching is strictly worse, never cheaper.
   */
  async webSearchBatch(queries: string[], options?: SearchOptions): Promise<SearchResult[][]> {
    if (queries.length === 0) return [];

    const page = options?.pageno ?? 1;
    // Google stopped honouring num > 10 in 2025; asking for more returns the same
    // ten and can be billed as a deeper page. Pagination is the only way deeper.
    const num = Math.min(options?.maxResults ?? 10, 10);
    const language = options?.language;

    const hl = this.hlOverride ?? (language ? language.toLowerCase() : 'zh-cn');
    const gl = this.glOverride ?? this.deriveCountryFromLanguage(language) ?? 'cn';
    const tbs = this.mapTimeRange(options?.timeRange);

    const payload = queries.map((q) => {
      const entry: Record<string, unknown> = { q, gl, hl, num, page, autocorrect: true };
      if (tbs) entry.tbs = tbs;
      return entry;
    });

    // A batch is one request but N queries' worth of work upstream, so the single
    // -query timeout would make large batches fail by construction.
    const timeoutMs = this.timeoutMs + (queries.length - 1) * BATCH_TIMEOUT_STEP_MS;

    logger.debug(
      `[SerperClient] Searching ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} (gl=${gl}, hl=${hl}, num=${num}, page=${page}): ${queries.join(' | ')}`,
    );

    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
            'Content-Type': 'application/json',
          },
          // Serper distinguishes batch from single by the body being an array, so a
          // one-element batch must still be sent wrapped to get an array back.
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Serper API error: ${response.status} ${response.statusText} ${text}`);
        }

        const parsed = (await response.json()) as SerperSearchResponse | SerperSearchResponse[];
        const responses = Array.isArray(parsed) ? parsed : [parsed];
        const mapped = responses.map((data) => this.mapResults(data));
        const credits = responses.reduce((sum, data) => sum + (data.credits ?? 0), 0);
        logger.debug(
          `[SerperClient] Batch completed: ${mapped.map((r) => r.length).join('+')} results, credits used=${credits || '?'}`,
        );
        return mapped;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = this.isRetryableError(lastError);
        if (attempt < maxRetries && isRetryable) {
          const delay = 2 ** attempt * 1000;
          logger.warn(
            `[SerperClient] Search failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
          );
          await this.delay(delay);
          continue;
        }
        logger.error(`[SerperClient] Search failed after ${attempt + 1} attempts:`, lastError);
        throw lastError;
      }
    }

    throw lastError || new Error('Serper search failed');
  }

  /**
   * Flatten one SERP into the unified `SearchResult` shape.
   *
   * Google answers a single query with far more than the organic ten, and every
   * block below is already paid for by the same credit — dropping them meant
   * paying for an encyclopaedia entry and reading only the bibliography. Each
   * block is tagged in `engine` so the model can weigh a direct answer against a
   * page it would still have to read, following the existing `google (answerBox)`
   * convention.
   */
  private mapResults(data: SerperSearchResponse): SearchResult[] {
    const results: SearchResult[] = [];

    const answer = data.answerBox?.answer || data.answerBox?.snippet;
    if (data.answerBox && answer) {
      results.push({
        title: data.answerBox.title || answer,
        url: data.answerBox.link || '',
        snippet: answer,
        engine: 'google (answerBox)',
      });
    }

    const kg = data.knowledgeGraph;
    if (kg?.title && (kg.description || kg.attributes)) {
      const attributes = Object.entries(kg.attributes ?? {})
        .map(([key, value]) => `${key}: ${value}`)
        .join('；');
      results.push({
        title: [kg.title, kg.type].filter(Boolean).join(' — '),
        url: kg.website || kg.descriptionLink || '',
        snippet: [kg.description, attributes].filter(Boolean).join('\n'),
        engine: 'google (knowledgeGraph)',
      });
    }

    for (const story of data.topStories ?? []) {
      if (!story.link || !story.title) continue;
      results.push({
        title: story.title,
        url: story.link,
        snippet: story.snippet || '',
        engine: `google (topStories${story.source ? `, ${story.source}` : ''})`,
        date: story.date,
      });
    }

    for (const item of data.organic || []) {
      if (!item.link) continue;
      const sitelinks = (item.sitelinks ?? [])
        .map((s) => s.title)
        .filter(Boolean)
        .join(' / ');
      results.push({
        title: item.title || '',
        url: item.link,
        snippet: sitelinks ? `${item.snippet || ''}\n（站内条目：${sitelinks}）` : item.snippet || '',
        engine: 'google',
        date: item.date,
      });
    }

    // Question/answer pairs Google already resolved. Often the fact itself, which
    // is why they are worth more than the link they came with.
    for (const paa of data.peopleAlsoAsk ?? []) {
      if (!paa.question || !paa.snippet) continue;
      results.push({
        title: paa.question,
        url: paa.link || '',
        snippet: paa.snippet,
        engine: 'google (peopleAlsoAsk)',
      });
    }

    return results;
  }

  private deriveCountryFromLanguage(language?: string): string | undefined {
    if (!language) return undefined;
    const parts = language.split('-');
    if (parts.length >= 2) return parts[1].toLowerCase();
    return undefined;
  }

  private mapTimeRange(timeRange?: SearchOptions['timeRange']): string | undefined {
    if (!timeRange) return undefined;
    if (timeRange === 'day') return 'qdr:d';
    if (timeRange === 'month') return 'qdr:m';
    if (timeRange === 'year') return 'qdr:y';
    return undefined;
  }

  private isRetryableError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return false;
    if (msg.includes('401') || msg.includes('403') || msg.includes('429')) return false;
    return ['network error', 'socket hang up', 'econnreset'].some((m) => msg.includes(m));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
