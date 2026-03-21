#!/usr/bin/env bun
/**
 * Moments Batch Sentiment Analysis Script
 *
 * Uses LLM to analyze sentiment/attitude of WeChat moments stored in Qdrant.
 * Results are saved to SQLite (wechat_moments_sentiment table) and a JSONL file.
 *
 * Usage:
 *   # Test with first 40 records (dry run — don't write to DB)
 *   bun scripts/moments/moments-sentiment.ts --limit 40 --dry-run
 *
 *   # Process all records (default: ollama)
 *   bun scripts/moments/moments-sentiment.ts
 *
 *   # Use a different provider
 *   bun scripts/moments/moments-sentiment.ts --provider deepseek
 *   bun scripts/moments/moments-sentiment.ts --provider doubao
 *
 *   # Use a custom model
 *   bun scripts/moments/moments-sentiment.ts --model qwen3:8b
 */

import {
  clampScore,
  loadSentimentPrompt,
  normalizeAttitudeTags,
  normalizeSentiment,
} from '../../src/services/wechat/moments/momentsSentiment';
import { WeChatDatabase } from '../../src/services/wechat/WeChatDatabase';
import {
  type QdrantPoint,
  loadConfig,
  parseArgs,
  printDistribution,
  printHeader,
  resolveLLMConnection,
  runBatchLoop,
  writeSummaryJson,
} from '../lib/moments-common';

const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_OUTPUT = 'data/moments-sentiment-results.jsonl';

interface SentimentResult {
  index: number;
  sentiment: string;
  score: number;
  attitude_tags: string[];
}

async function main() {
  const args = parseArgs({ model: DEFAULT_MODEL, batchSize: DEFAULT_BATCH_SIZE, output: DEFAULT_OUTPUT });
  const config = loadConfig();

  if (!config.rag?.enabled) {
    console.error('RAG is not enabled in config. Exiting.');
    process.exit(1);
  }

  const qdrantUrl = config.rag.qdrant.url;
  const llm = resolveLLMConnection(config, args.provider, args.model);

  const db = new WeChatDatabase();
  await db.init();

  const analyzedCount = db.getMomentsSentimentCount();
  console.log(`Already analyzed: ${analyzedCount} moments in SQLite`);

  const sentimentStats = new Map<string, number>();

  printHeader('Moments Batch Sentiment Analysis', {
    'Qdrant:': qdrantUrl,
    'Provider:': `${llm.provider} (${llm.type})`,
    'Model:': llm.model,
    'Batch size:': args.batchSize,
    'Limit:': args.limit || 'unlimited',
    'Dry run:': args.dryRun,
    'Output:': args.output,
  });

  const result = await runBatchLoop<SentimentResult>({
    qdrantUrl,
    llm,
    batchSize: args.batchSize,
    limit: args.limit,
    output: args.output,
    dryRun: args.dryRun,
    payloadInclude: ['content', 'create_time'],
    promptBuilder: loadSentimentPrompt,
    processResult: (sr: SentimentResult, point: QdrantPoint) => {
      const sentiment = normalizeSentiment(sr.sentiment);
      const score = clampScore(sr.score);
      const attitudeTags = normalizeAttitudeTags(Array.isArray(sr.attitude_tags) ? sr.attitude_tags : []);
      const createTime = (point.payload.create_time as string) || '';

      if (!args.dryRun) {
        db.upsertMomentSentiment({
          momentId: String(point.id),
          sentiment,
          score,
          attitudeTags,
          createTime,
        });
      }

      sentimentStats.set(sentiment, (sentimentStats.get(sentiment) ?? 0) + 1);

      const contentPreview = ((point.payload.content as string) || '').slice(0, 60);
      console.log(`  [${sr.index}] ${sentiment} (${score.toFixed(2)}) ${attitudeTags.join(', ')}`);
      console.log(`       "${contentPreview}..."`);

      return { id: point.id, createTime, sentiment, score, attitudeTags };
    },
  });

  console.log('\n=== Summary ===');
  console.log(`Total processed: ${result.totalProcessed}`);
  console.log(`Total analyzed:  ${result.totalSuccess}`);
  console.log(`Total failed:    ${result.totalFailed}`);
  console.log(`Output file:     ${args.output}`);
  if (args.dryRun) console.log('(Dry run — no data was written to SQLite)');

  writeSummaryJson(args.output, {
    provider: llm.provider,
    model: llm.model,
    totalProcessed: result.totalProcessed,
    totalAnalyzed: result.totalSuccess,
    totalFailed: result.totalFailed,
    dryRun: args.dryRun,
    sentimentDistribution: Object.fromEntries([...sentimentStats.entries()].sort((a, b) => b[1] - a[1])),
    timestamp: new Date().toISOString(),
  });

  printDistribution(sentimentStats, 'Sentiment distribution');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
