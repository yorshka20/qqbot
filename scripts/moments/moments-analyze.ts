#!/usr/bin/env bun
/**
 * Moments Batch Analysis Script — Sentiment + NER in a single LLM call per batch
 *
 * Scrolls all moments from Qdrant once, runs one combined LLM call per batch
 * to extract both sentiment and entities simultaneously.
 * Results are saved to SQLite.
 *
 * Usage:
 *   # Dry run with first 40 records
 *   bun scripts/moments/moments-analyze.ts --limit 40 --dry-run
 *
 *   # Process all records (default: ollama)
 *   bun scripts/moments/moments-analyze.ts
 *
 *   # Use a cloud provider
 *   bun scripts/moments/moments-analyze.ts --provider deepseek
 *   bun scripts/moments/moments-analyze.ts --provider doubao
 *
 *   # Custom model and batch size
 *   bun scripts/moments/moments-analyze.ts --model qwen3:8b --batch 10
 */

import {
  clampScore,
  loadCombinedAnalysisPrompt,
  normalizeAttitudeTags,
  normalizeSentiment,
} from '../../src/services/wechat/moments/momentsSentiment';
import {
  normalizeEntityName,
  normalizeEntityType,
} from '../../src/services/wechat/moments/momentsEntities';
import { WeChatDatabase } from '../../src/services/wechat/WeChatDatabase';
import {
  callLLM,
  ensureOutputDir,
  appendJsonl,
  loadConfig,
  parseArgs,
  printDistribution,
  printHeader,
  qdrantScroll,
  resolveLLMConnection,
  writeSummaryJson,
} from '../lib/moments-common';

const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_BATCH_SIZE = 15; // Slightly smaller — combined output is larger per item
const DEFAULT_OUTPUT = 'data/moments-analyze-results.jsonl';

interface CombinedResult {
  index: number;
  sentiment: string;
  score: number;
  attitude_tags: string[];
  entities: Array<{ name: string; type: string }>;
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

  console.log(`Already analyzed: sentiment=${db.getMomentsSentimentCount()}, entities=${db.getMomentsEntityMomentCount()}`);

  ensureOutputDir(args.output);

  printHeader('Moments Batch Analysis (Sentiment + NER, single call)', {
    'Qdrant:': qdrantUrl,
    'Provider:': `${llm.provider} (${llm.type})`,
    'Model:': llm.model,
    'Batch size:': args.batchSize,
    'Limit:': args.limit || 'unlimited',
    'Dry run:': args.dryRun,
    'Output:': args.output,
  });

  const sentimentStats = new Map<string, number>();
  const entityTypeStats = new Map<string, number>();
  const topEntities = new Map<string, number>();

  let offset: string | number | null = null;
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalEntities = 0;
  let batchNum = 0;

  while (true) {
    if (args.limit > 0 && totalProcessed >= args.limit) break;

    const fetchCount = args.limit > 0 ? Math.min(args.batchSize, args.limit - totalProcessed) : args.batchSize;

    const scrollRes = await qdrantScroll(qdrantUrl, offset, fetchCount, {
      payloadInclude: ['content', 'create_time'],
    });
    const points = scrollRes.result.points;

    if (points.length === 0) {
      console.log('\nNo more records to process.');
      break;
    }

    batchNum++;
    console.log(`\n--- Batch ${batchNum}: ${points.length} records ---`);

    const contents = points.map((p, i) => ({
      index: i,
      content: (p.payload.content as string) || '',
    }));

    try {
      const results = await callLLM<CombinedResult>(llm, contents, loadCombinedAnalysisPrompt);

      for (const r of results) {
        if (r.index < 0 || r.index >= points.length) continue;

        const point = points[r.index];
        const createTime = (point.payload.create_time as string) || '';

        // Sentiment
        const sentiment = normalizeSentiment(r.sentiment);
        const score = clampScore(r.score);
        const attitudeTags = normalizeAttitudeTags(Array.isArray(r.attitude_tags) ? r.attitude_tags : []);

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

        if (!args.dryRun) {
          db.upsertMomentSentiment({ momentId: String(point.id), sentiment, score, attitudeTags, createTime });
          db.upsertMomentEntities(String(point.id), createTime, validEntities);
        }

        sentimentStats.set(sentiment, (sentimentStats.get(sentiment) ?? 0) + 1);
        for (const e of validEntities) {
          entityTypeStats.set(e.type, (entityTypeStats.get(e.type) ?? 0) + 1);
          topEntities.set(e.name, (topEntities.get(e.name) ?? 0) + 1);
        }
        totalEntities += validEntities.length;

        appendJsonl(args.output, {
          id: point.id,
          createTime,
          sentiment,
          score,
          attitudeTags,
          entities: validEntities,
        });

        totalSuccess++;
        const entityPreview = validEntities.slice(0, 3).map((e) => e.name).join(', ');
        console.log(`  [${r.index}] ${sentiment}(${score.toFixed(1)}) | ${entityPreview || '-'}`);
      }

      const returnedIndices = new Set(results.map((r) => r.index));
      for (let i = 0; i < points.length; i++) {
        if (!returnedIndices.has(i)) {
          console.log(`  [${i}] MISSED by LLM — skipping`);
          totalFailed++;
        }
      }
    } catch (err) {
      console.error(`  Batch ${batchNum} FAILED:`, err instanceof Error ? err.message : err);
      totalFailed += points.length;
    }

    totalProcessed += points.length;
    offset = scrollRes.result.next_page_offset;
    console.log(`  Progress: ${totalProcessed} processed, ${totalSuccess} OK, ${totalFailed} failed`);

    if (offset == null) {
      console.log('\nReached end of collection.');
      break;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total processed:    ${totalProcessed}`);
  console.log(`Total success:      ${totalSuccess}`);
  console.log(`Total failed:       ${totalFailed}`);
  console.log(`Total entities:     ${totalEntities}`);
  console.log(`Output file:        ${args.output}`);
  if (args.dryRun) console.log('(Dry run — no data was written to SQLite)');

  const sortedEntities = [...topEntities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  writeSummaryJson(args.output, {
    provider: llm.provider,
    model: llm.model,
    totalProcessed,
    totalSuccess,
    totalFailed,
    totalEntities,
    dryRun: args.dryRun,
    sentimentDistribution: Object.fromEntries([...sentimentStats.entries()].sort((a, b) => b[1] - a[1])),
    entityTypeDistribution: Object.fromEntries([...entityTypeStats.entries()].sort((a, b) => b[1] - a[1])),
    topEntities: Object.fromEntries(sortedEntities),
    timestamp: new Date().toISOString(),
  });

  printDistribution(sentimentStats, 'Sentiment distribution');
  printDistribution(entityTypeStats, 'Entity type distribution');

  if (topEntities.size > 0) {
    console.log('\nTop 20 entities:');
    for (const [name, count] of sortedEntities.slice(0, 20)) {
      console.log(`  ${name.padEnd(20)} ${String(count).padStart(4)}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
