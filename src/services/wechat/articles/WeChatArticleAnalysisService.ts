// WeChatArticleAnalysisService — fetches unanalyzed articles, runs LLM analysis via deepseek/doubao,
// and stores extracted insights into wechat_article_insights table.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import type { WeChatDatabase, WeChatOAArticleRow } from '../WeChatDatabase';
import { fetchArticleText } from './fetchArticleText';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Allowed providers for article analysis (cost-controlled). */
const ALLOWED_PROVIDERS = ['deepseek', 'doubao'] as const;

export interface ArticleAnalysisConfig {
  /** Provider name to use for analysis. Default: "deepseek". Only "deepseek" and "doubao" are allowed. */
  provider?: string;
  /** Path to prompt template file (default "prompts/analysis/wechat_article.txt") */
  promptPath?: string;
  /** Max articles to analyze per run (default 100) */
  maxArticles?: number;
  /** Concurrency — how many articles to analyze in parallel (default 1) */
  concurrency?: number;
}

interface AnalysisItem {
  type: 'fact' | 'opinion' | 'news' | 'insight';
  content: string;
  tags: string[];
  importance: 'high' | 'medium' | 'low';
}

interface AnalysisResult {
  category_tags: string[];
  items: AnalysisItem[];
  headline: string;
  worthReporting: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class WeChatArticleAnalysisService {
  private provider: string;
  private promptTemplate: string;
  private maxArticles: number;
  private concurrency: number;

  constructor(
    private db: WeChatDatabase,
    private llmService: LLMService,
    private config: ArticleAnalysisConfig,
  ) {
    const requestedProvider = config.provider ?? 'deepseek';
    this.provider = ALLOWED_PROVIDERS.includes(requestedProvider as (typeof ALLOWED_PROVIDERS)[number])
      ? requestedProvider
      : 'deepseek';
    this.maxArticles = config.maxArticles ?? 100;
    this.concurrency = config.concurrency ?? 1;

    // Load prompt template
    const promptPath = resolve(config.promptPath ?? 'prompts/analysis/wechat_article.txt');
    this.promptTemplate = readFileSync(promptPath, 'utf-8');
    logger.info(`[ArticleAnalysis] Initialized | provider=${this.provider} prompt=${promptPath}`);
  }

  /**
   * Run analysis on unanalyzed articles, scanning backwards from now.
   * Uses the `analyzed` column on wechat_oa_articles to skip already-processed articles.
   * @param count  Maximum number of articles to analyze this run (default: this.maxArticles)
   */
  async analyzeArticles(count?: number): Promise<{
    total: number;
    analyzed: number;
    skipped: number;
    worthReporting: number;
    failed: number;
  }> {
    const limit = count ?? this.maxArticles;

    // 1. Get unanalyzed articles ordered by pubTime DESC (most recent first)
    const articles = this.db.getArticles({
      analyzed: false,
      limit,
    });

    if (articles.length === 0) {
      logger.info('[ArticleAnalysis] No unanalyzed articles found');
      return { total: 0, analyzed: 0, skipped: 0, worthReporting: 0, failed: 0 };
    }

    // 2. Skip articles that already have insights but weren't marked (legacy data)
    const existingIds = this.db.getAnalyzedArticleIds();
    const alreadyDone = articles.filter((a) => existingIds.has(a.msgId));
    if (alreadyDone.length > 0) {
      this.db.markArticlesAnalyzed(alreadyDone.map((a) => a.msgId));
      logger.info(`[ArticleAnalysis] Marked ${alreadyDone.length} articles as analyzed (insights already exist)`);
    }
    const pending = articles.filter((a) => !existingIds.has(a.msgId));

    if (pending.length === 0) {
      logger.info('[ArticleAnalysis] All fetched articles already have insights, nothing to analyze');
      return { total: articles.length, analyzed: 0, skipped: alreadyDone.length, worthReporting: 0, failed: 0 };
    }

    logger.info(
      `[ArticleAnalysis] ${pending.length} to analyze, ${alreadyDone.length} skipped (already had insights) | provider: ${this.provider}`,
    );

    // 3. Analyze in batches with concurrency control
    let analyzed = 0;
    let worthReporting = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += this.concurrency) {
      const batch = pending.slice(i, i + this.concurrency);
      const results = await Promise.allSettled(batch.map((article) => this.analyzeOne(article)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          analyzed++;
          if (result.value) worthReporting++;
        } else {
          failed++;
        }
      }

      // Progress log every 10 articles
      if (analyzed % 10 === 0 || i + this.concurrency >= pending.length) {
        logger.info(
          `[ArticleAnalysis] Progress: ${analyzed + failed}/${pending.length} (${analyzed} OK, ${failed} failed)`,
        );
      }
    }

    return { total: articles.length, analyzed, skipped: alreadyDone.length, worthReporting, failed };
  }

  /**
   * Analyze a single article: fetch full text → call LLM → store insight.
   * Returns true if article is worthReporting.
   */
  private async analyzeOne(article: WeChatOAArticleRow): Promise<boolean> {
    const { msgId, title, url, summary, source, accountNick } = article;

    // Fetch full text
    const fullText = url ? await fetchArticleText(url, summary || title) : summary || title;
    const isFetchFailed = fullText === title || fullText === summary;

    if (isFetchFailed && (!summary || summary.length < 50)) {
      logger.warn(`[ArticleAnalysis] Skipping "${title}" — no content available`);
      // Store as not worth reporting so we don't retry, and mark as analyzed
      this.db.insertArticleInsight({
        articleMsgId: msgId,
        title,
        url,
        source: source || accountNick,
        headline: '',
        categoryTags: '[]',
        items: '[]',
        worthReporting: 0,
        analyzedAt: new Date().toISOString(),
        model: this.provider,
      });
      this.db.markArticleAnalyzed(msgId);
      return false;
    }

    // Build prompt
    const content = isFetchFailed ? summary : fullText;
    const prompt = this.promptTemplate
      .replace('{{title}}', title)
      .replace('{{source}}', source || accountNick)
      .replace('{{content}}', content);

    // Call LLM via provider
    const analysisResult = await this.callLLM(prompt, title);
    if (!analysisResult) {
      throw new Error(`LLM returned no parseable result for "${title}"`);
    }

    // Store insight in DB and mark article as analyzed
    this.db.insertArticleInsight({
      articleMsgId: msgId,
      title,
      url,
      source: source || accountNick,
      headline: analysisResult.headline || '',
      categoryTags: JSON.stringify(analysisResult.category_tags ?? []),
      items: JSON.stringify(analysisResult.items ?? []),
      worthReporting: analysisResult.worthReporting ? 1 : 0,
      analyzedAt: new Date().toISOString(),
      model: this.provider,
    });
    this.db.markArticleAnalyzed(msgId);

    logger.info(
      `[ArticleAnalysis] ✓ "${title}" → ${analysisResult.items?.length ?? 0} items, worth=${analysisResult.worthReporting}`,
    );

    return analysisResult.worthReporting;
  }

  /**
   * Call LLM via LLMService and parse JSON response.
   * Fallback is restricted to ALLOWED_PROVIDERS only (deepseek / doubao).
   */
  private async callLLM(prompt: string, title: string): Promise<AnalysisResult | null> {
    const fallbackProvider = this.provider === 'deepseek' ? 'doubao' : 'deepseek';

    for (const providerName of [this.provider, fallbackProvider]) {
      try {
        const provider = await this.llmService.getAvailableProvider(providerName);
        if (!provider) {
          logger.warn(`[ArticleAnalysis] Provider "${providerName}" not available, skipping`);
          continue;
        }

        const response = await provider.generate(prompt, { temperature: 0.3, maxTokens: 2048, jsonMode: true });
        const text = response.text?.trim();
        if (!text) {
          logger.warn(`[ArticleAnalysis] Empty response from "${providerName}" for "${title}"`);
          continue;
        }

        return this.parseJSON(text, title);
      } catch (err) {
        logger.warn(`[ArticleAnalysis] Provider "${providerName}" failed for "${title}":`, err);
        // try fallback
      }
    }

    logger.error(`[ArticleAnalysis] All allowed providers failed for "${title}"`);
    throw new Error(`All allowed providers (${ALLOWED_PROVIDERS.join(', ')}) failed for "${title}"`);
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks).
   */
  private parseJSON(text: string, title: string): AnalysisResult | null {
    // Try extracting from ```json ... ``` block first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text;

    try {
      const parsed = JSON.parse(jsonStr);
      // Basic validation
      if (typeof parsed.worthReporting !== 'boolean') {
        parsed.worthReporting = false;
      }
      if (!Array.isArray(parsed.items)) {
        parsed.items = [];
      }
      if (!Array.isArray(parsed.category_tags)) {
        parsed.category_tags = [];
      }
      if (typeof parsed.headline !== 'string') {
        parsed.headline = '';
      }
      return parsed as AnalysisResult;
    } catch {
      logger.warn(`[ArticleAnalysis] JSON parse failed for "${title}", raw:\n${jsonStr.slice(0, 200)}`);
      return null;
    }
  }
}
