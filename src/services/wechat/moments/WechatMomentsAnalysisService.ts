/**
 * WechatMomentsAnalysisService
 *
 * Runs LLM-based analysis on newly ingested moments:
 * 1. Tagging + Summary → updates Qdrant payload (tags, summary)
 * 2. Sentiment + NER (combined) → saves to SQLite
 *
 * Designed to be called after WechatMomentsIngestService.ingest() completes.
 * Uses the same prompt templates and normalization as the batch scripts.
 */

import type { LLMService } from '@/ai/services/LLMService';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import type { WeChatDatabase } from '../WeChatDatabase';
import { normalizeEntityName, normalizeEntityType } from './momentsEntities';
import { clampScore, loadCombinedAnalysisPrompt, normalizeAttitudeTags, normalizeSentiment } from './momentsSentiment';
import { loadTaggingPrompt, normalizeTags } from './momentsTags';

const COLLECTION = 'wechat_moments';
const TAG_BATCH_SIZE = 20;
const ANALYSIS_BATCH_SIZE = 15;

export interface MomentsAnalysisConfig {
  /** LLM provider name (e.g. 'deepseek', 'doubao', 'ollama'). Default: 'ollama'. */
  provider?: string;
}

export interface MomentsAnalysisResult {
  tagged: number;
  analyzed: number;
  failed: number;
}

interface TagResult {
  index: number;
  tags: string[];
  summary: string;
}

interface CombinedResult {
  index: number;
  sentiment: string;
  score: number;
  attitude_tags: string[];
  entities: Array<{ name: string; type: string }>;
}

interface MomentItem {
  id: string;
  content: string;
  createTime: string;
}

export class WechatMomentsAnalysisService {
  private provider: string;

  constructor(
    private readonly llmService: LLMService,
    private readonly retrieval: RetrievalService,
    private readonly db: WeChatDatabase,
    config?: MomentsAnalysisConfig,
  ) {
    this.provider = config?.provider ?? 'ollama';
  }

  /**
   * Run tagging + sentiment/NER analysis on the given moment IDs.
   * Called after ingest with the list of newly ingested document IDs.
   */
  async analyze(momentIds: string[]): Promise<MomentsAnalysisResult> {
    if (momentIds.length === 0) {
      return { tagged: 0, analyzed: 0, failed: 0 };
    }

    logger.info(`[MomentsAnalysis] Starting analysis for ${momentIds.length} moments | provider=${this.provider}`);

    // Fetch moment content from Qdrant
    const moments = await this.fetchMoments(momentIds);
    if (moments.length === 0) {
      logger.warn('[MomentsAnalysis] No moments found in Qdrant for the given IDs');
      return { tagged: 0, analyzed: 0, failed: 0 };
    }

    // Run tagging and combined analysis in sequence (to avoid overloading the LLM)
    const tagResult = await this.runTagging(moments);
    const analysisResult = await this.runCombinedAnalysis(moments);

    const result: MomentsAnalysisResult = {
      tagged: tagResult.success,
      analyzed: analysisResult.success,
      failed: tagResult.failed + analysisResult.failed,
    };

    logger.info(`[MomentsAnalysis] Done | tagged=${result.tagged} analyzed=${result.analyzed} failed=${result.failed}`);

    return result;
  }

  private async fetchMoments(momentIds: string[]): Promise<MomentItem[]> {
    const moments: MomentItem[] = [];

    // Scroll through the collection and filter by our IDs
    const idSet = new Set(momentIds);
    for await (const page of this.retrieval.scrollAll(COLLECTION, {
      limit: 100,
      withPayload: { include: ['content', 'create_time'] } as unknown as boolean,
    })) {
      for (const point of page) {
        const id = String(point.id);
        if (idSet.has(id)) {
          moments.push({
            id,
            content: (point.payload.content as string) || '',
            createTime: (point.payload.create_time as string) || '',
          });
          idSet.delete(id);
        }
      }
      if (idSet.size === 0) break;
    }

    return moments;
  }

  /**
   * Run tagging + summary on moments, update Qdrant payload.
   */
  private async runTagging(moments: MomentItem[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (let i = 0; i < moments.length; i += TAG_BATCH_SIZE) {
      const batch = moments.slice(i, i + TAG_BATCH_SIZE);
      const contents = batch.map((m, idx) => ({ index: idx, content: m.content }));

      try {
        const results = await this.callLLM<TagResult>(contents, loadTaggingPrompt);

        for (const r of results) {
          if (r.index < 0 || r.index >= batch.length) continue;
          const moment = batch[r.index];

          const tags = normalizeTags(Array.isArray(r.tags) ? r.tags : []);
          const summary = typeof r.summary === 'string' ? r.summary : '';

          await this.retrieval.setPayload(COLLECTION, [moment.id], { tags, summary });
          success++;
        }

        const missed = batch.length - results.filter((r) => r.index >= 0 && r.index < batch.length).length;
        failed += missed;
      } catch (err) {
        logger.error('[MomentsAnalysis] Tagging batch failed:', err);
        failed += batch.length;
      }
    }

    logger.info(`[MomentsAnalysis] Tagging done | success=${success} failed=${failed}`);
    return { success, failed };
  }

  /**
   * Run combined sentiment + NER analysis, save to SQLite.
   */
  private async runCombinedAnalysis(moments: MomentItem[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (let i = 0; i < moments.length; i += ANALYSIS_BATCH_SIZE) {
      const batch = moments.slice(i, i + ANALYSIS_BATCH_SIZE);
      const contents = batch.map((m, idx) => ({ index: idx, content: m.content }));

      try {
        const results = await this.callLLM<CombinedResult>(contents, loadCombinedAnalysisPrompt);

        for (const r of results) {
          if (r.index < 0 || r.index >= batch.length) continue;
          const moment = batch[r.index];

          // Sentiment
          const sentiment = normalizeSentiment(r.sentiment);
          const score = clampScore(r.score);
          const attitudeTags = normalizeAttitudeTags(Array.isArray(r.attitude_tags) ? r.attitude_tags : []);

          this.db.upsertMomentSentiment({
            momentId: moment.id,
            sentiment,
            score,
            attitudeTags,
            createTime: moment.createTime,
          });

          // NER
          const rawEntities = Array.isArray(r.entities) ? r.entities : [];
          const validEntities: Array<{ name: string; type: string }> = [];
          for (const e of rawEntities) {
            const type = normalizeEntityType(e.type);
            const name = normalizeEntityName(e.name);
            if (type && name.length >= 2) {
              validEntities.push({ name, type });
            }
          }

          this.db.upsertMomentEntities(moment.id, moment.createTime, validEntities);
          success++;
        }

        const missed = batch.length - results.filter((r) => r.index >= 0 && r.index < batch.length).length;
        failed += missed;
      } catch (err) {
        logger.error('[MomentsAnalysis] Combined analysis batch failed:', err);
        failed += batch.length;
      }
    }

    logger.info(`[MomentsAnalysis] Combined analysis done | success=${success} failed=${failed}`);
    return { success, failed };
  }

  /**
   * Call LLM via LLMService with batch prompt, parse JSON array response.
   */
  private async callLLM<T>(
    contents: Array<{ index: number; content: string }>,
    promptBuilder: (contentList: string) => string,
  ): Promise<T[]> {
    const contentList = contents.map((c) => `[${c.index}] ${(c.content || '').slice(0, 500)}`).join('\n\n');
    const prompt = promptBuilder(contentList);

    const provider = await this.llmService.getAvailableProvider(this.provider);
    if (!provider) {
      throw new Error(`LLM provider "${this.provider}" is not available`);
    }

    const response = await provider.generate(prompt, { temperature: 0.3, maxTokens: 4096 });
    const text = response.text?.trim() ?? '';

    return this.extractJsonArray<T>(text);
  }

  private extractJsonArray<T>(text: string): T[] {
    // Strip <think>...</think> blocks (e.g. qwen3 reasoning output)
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`No JSON array found in LLM response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(jsonMatch[0]) as T[];
  }
}
