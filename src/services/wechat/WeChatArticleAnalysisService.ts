// WeChatArticleAnalysisService — fetches today's articles, runs LLM analysis via Ollama,
// and stores extracted insights into wechat_article_insights table.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { fetchArticleText } from './fetchArticleText';
import type { WeChatDatabase, WeChatOAArticleRow } from './WeChatDatabase';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ArticleAnalysisConfig {
  /** Ollama API base URL (e.g. "http://192.168.1.100:11434") */
  ollamaUrl: string;
  /** Model name to use (e.g. "qwen3:8b") */
  model: string;
  /** Request timeout in ms (default 120000 — articles can be long) */
  timeout?: number;
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

interface OllamaChatResponse {
  message?: { content?: string };
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class WeChatArticleAnalysisService {
  private httpClient: HttpClient;
  private model: string;
  private promptTemplate: string;
  private maxArticles: number;
  private concurrency: number;

  constructor(
    private db: WeChatDatabase,
    private config: ArticleAnalysisConfig,
  ) {
    this.model = config.model;
    this.maxArticles = config.maxArticles ?? 100;
    this.concurrency = config.concurrency ?? 1;

    this.httpClient = new HttpClient({
      baseURL: config.ollamaUrl.replace(/\/$/, ''),
      defaultHeaders: { 'Content-Type': 'application/json' },
      defaultTimeout: config.timeout ?? 120_000,
    });

    // Load prompt template
    const promptPath = resolve(config.promptPath ?? 'prompts/analysis/wechat_article.txt');
    this.promptTemplate = readFileSync(promptPath, 'utf-8');
    logger.info(`[ArticleAnalysis] Loaded prompt from ${promptPath}`);
  }

  /**
   * Run analysis on articles received since `sinceTs`.
   * Skips articles that already have insights in the DB.
   * Returns count of newly analyzed articles.
   */
  async analyzeArticles(sinceTs: number, untilTs?: number): Promise<{
    total: number;
    analyzed: number;
    skipped: number;
    worthReporting: number;
    failed: number;
  }> {
    // 1. Get articles from DB
    const articles = this.db.getArticles({
      sinceTs,
      untilTs,
      limit: this.maxArticles,
    });

    if (articles.length === 0) {
      logger.info('[ArticleAnalysis] No articles found in the given time range');
      return { total: 0, analyzed: 0, skipped: 0, worthReporting: 0, failed: 0 };
    }

    // 2. Filter out already-analyzed
    const analyzedIds = this.db.getAnalyzedArticleIds();
    const pending = articles.filter((a) => !analyzedIds.has(a.msgId));
    const skipped = articles.length - pending.length;

    logger.info(
      `[ArticleAnalysis] Found ${articles.length} articles, ${skipped} already analyzed, ${pending.length} to process`,
    );

    // 3. Analyze in batches with concurrency control
    let analyzed = 0;
    let worthReporting = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += this.concurrency) {
      const batch = pending.slice(i, i + this.concurrency);
      const results = await Promise.allSettled(
        batch.map((article) => this.analyzeOne(article)),
      );

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

    return { total: articles.length, analyzed, skipped, worthReporting, failed };
  }

  /**
   * Analyze a single article: fetch full text → call Ollama → store insight.
   * Returns true if article is worthReporting.
   */
  private async analyzeOne(article: WeChatOAArticleRow): Promise<boolean> {
    const { msgId, title, url, summary, source, accountNick } = article;

    // Fetch full text
    const fullText = url ? await fetchArticleText(url, summary || title) : summary || title;
    const isFetchFailed = fullText === title || fullText === summary;

    if (isFetchFailed && (!summary || summary.length < 50)) {
      logger.warn(`[ArticleAnalysis] Skipping "${title}" — no content available`);
      // Store as not worth reporting so we don't retry
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
        model: this.model,
      });
      return false;
    }

    // Build prompt
    const content = isFetchFailed ? summary : fullText;
    const prompt = this.promptTemplate
      .replace('{{title}}', title)
      .replace('{{source}}', source || accountNick)
      .replace('{{content}}', content);

    // Call Ollama
    const analysisResult = await this.callOllama(prompt, title);
    if (!analysisResult) {
      throw new Error(`LLM returned no parseable result for "${title}"`);
    }

    // Store in DB
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
      model: this.model,
    });

    logger.info(
      `[ArticleAnalysis] ✓ "${title}" → ${analysisResult.items?.length ?? 0} items, worth=${analysisResult.worthReporting}`,
    );

    return analysisResult.worthReporting;
  }

  /**
   * Call Ollama chat API and parse JSON response.
   */
  private async callOllama(prompt: string, title: string): Promise<AnalysisResult | null> {
    try {
      const response = await this.httpClient.post<OllamaChatResponse>('/api/chat', {
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 2048,
        },
      });

      const text = response.message?.content?.trim();
      if (!text) {
        logger.warn(`[ArticleAnalysis] Empty response for "${title}"`);
        return null;
      }

      return this.parseJSON(text, title);
    } catch (err) {
      logger.error(`[ArticleAnalysis] Ollama error for "${title}":`, err);
      throw err;
    }
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
