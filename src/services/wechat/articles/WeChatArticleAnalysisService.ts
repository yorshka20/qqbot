// WeChatArticleAnalysisService — fetches unanalyzed articles, runs LLM analysis via configurable provider
// (default: doubao, no fallback, retry on timeout), and stores extracted insights into wechat_article_insights table.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import type { WeChatDatabase, WeChatOAArticleRow } from '../WeChatDatabase';
import { fetchArticleText } from './fetchArticleText';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ArticleAnalysisConfig {
  /** Provider name to use for analysis. Default: "doubao". No fallback — retries on timeout. */
  provider?: string;
  /** Model override for the analysis provider (optional) */
  model?: string;
  /** Max articles to analyze per run (default 100) */
  maxArticles?: number;
  /** Concurrency — how many articles to analyze in parallel (default 1) */
  concurrency?: number;
  /** Max retries on transient errors (default 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default 2000) */
  retryDelayMs?: number;
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
  /** Whether this article has long-term value (e.g. tutorials, knowledge) vs time-sensitive news. Default: false */
  evergreen: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class WeChatArticleAnalysisService {
  private provider: string;
  private model: string | undefined;
  private maxArticles: number;
  private concurrency: number;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(
    private db: WeChatDatabase,
    private llmService: LLMService,
    private promptManager: PromptManager,
    config: ArticleAnalysisConfig,
  ) {
    this.provider = config.provider ?? 'doubao';
    this.model = config.model;
    this.maxArticles = config.maxArticles ?? 100;
    this.concurrency = config.concurrency ?? 1;
    this.maxRetries = config.maxRetries ?? 5;
    this.retryDelayMs = config.retryDelayMs ?? 2000;

    logger.info(`[ArticleAnalysis] Initialized | provider=${this.provider}`);
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
        evergreen: 0,
        analyzedAt: new Date().toISOString(),
        model: this.provider,
      });
      this.db.markArticleAnalyzed(msgId);
      return false;
    }

    // Build prompt
    const content = isFetchFailed ? summary : fullText;
    const prompt = this.promptManager.render('analysis.wechat_article', {
      title,
      source: source || accountNick,
      content,
    });

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
      evergreen: analysisResult.evergreen ? 1 : 0,
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
   * Call LLM via LLMService.generateFixed (no fallback, retry-only).
   * Delegates retry logic to LLMService so the service handles transient errors uniformly.
   */
  private async callLLM(prompt: string, title: string): Promise<AnalysisResult | null> {
    const response = await this.llmService.generateFixed(
      this.provider,
      prompt,
      {
        temperature: 0.3,
        maxTokens: 2048,
        jsonMode: true,
        model: this.model,
      },
      {
        maxRetries: this.maxRetries,
        retryDelayMs: this.retryDelayMs,
      },
    );

    const text = response.text?.trim();
    if (!text) {
      logger.warn(`[ArticleAnalysis] Empty response from "${this.provider}" for "${title}"`);
      return null;
    }
    return this.parseJSON(text, title);
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
      if (typeof parsed.evergreen !== 'boolean') {
        parsed.evergreen = false;
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
