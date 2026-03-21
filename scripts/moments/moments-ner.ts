#!/usr/bin/env bun
/**
 * Moments Batch Named Entity Recognition Script
 *
 * Uses LLM to extract named entities from WeChat moments stored in Qdrant.
 * Results are saved to SQLite (wechat_moments_entities table) and a JSONL file.
 *
 * Usage:
 *   # Test with first 40 records (dry run — don't write to DB)
 *   bun scripts/moments/moments-ner.ts --limit 40 --dry-run
 *
 *   # Process all records (default: ollama)
 *   bun scripts/moments/moments-ner.ts
 *
 *   # Use a different provider
 *   bun scripts/moments/moments-ner.ts --provider deepseek
 *   bun scripts/moments/moments-ner.ts --provider doubao
 *
 *   # Use a custom model
 *   bun scripts/moments/moments-ner.ts --model qwen3:8b
 */

import {
  loadNERPrompt,
  normalizeEntityName,
  normalizeEntityType,
} from '../../src/services/wechat/moments/momentsEntities';
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
const DEFAULT_OUTPUT = 'data/moments-ner-results.jsonl';

interface NERResult {
  index: number;
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

  const analyzedCount = db.getMomentsEntityMomentCount();
  console.log(`Already extracted: ${analyzedCount} moments in SQLite`);

  const entityTypeStats = new Map<string, number>();
  const topEntities = new Map<string, number>();
  let totalEntities = 0;

  printHeader('Moments Batch NER', {
    'Qdrant:': qdrantUrl,
    'Provider:': `${llm.provider} (${llm.type})`,
    'Model:': llm.model,
    'Batch size:': args.batchSize,
    'Limit:': args.limit || 'unlimited',
    'Dry run:': args.dryRun,
    'Output:': args.output,
  });

  const result = await runBatchLoop<NERResult>({
    qdrantUrl,
    llm,
    batchSize: args.batchSize,
    limit: args.limit,
    output: args.output,
    dryRun: args.dryRun,
    payloadInclude: ['content', 'create_time'],
    promptBuilder: loadNERPrompt,
    processResult: (nr: NERResult, point: QdrantPoint) => {
      const createTime = (point.payload.create_time as string) || '';
      const rawEntities = Array.isArray(nr.entities) ? nr.entities : [];

      const validEntities: Array<{ name: string; type: string }> = [];
      for (const e of rawEntities) {
        const type = normalizeEntityType(e.type);
        const name = normalizeEntityName(e.name);
        if (type && name.length >= 2) {
          validEntities.push({ name, type });
        }
      }

      if (!args.dryRun) {
        db.upsertMomentEntities(String(point.id), createTime, validEntities);
      }

      for (const e of validEntities) {
        entityTypeStats.set(e.type, (entityTypeStats.get(e.type) ?? 0) + 1);
        topEntities.set(e.name, (topEntities.get(e.name) ?? 0) + 1);
      }
      totalEntities += validEntities.length;

      const entityPreview = validEntities.map((e) => `${e.name}(${e.type})`).join(', ');
      console.log(`  [${nr.index}] ${validEntities.length} entities: ${entityPreview || '(none)'}`);

      return { id: point.id, createTime, entities: validEntities };
    },
  });

  console.log('\n=== Summary ===');
  console.log(`Total processed: ${result.totalProcessed}`);
  console.log(`Total extracted: ${result.totalSuccess}`);
  console.log(`Total entities:  ${totalEntities}`);
  console.log(`Total failed:    ${result.totalFailed}`);
  console.log(`Output file:     ${args.output}`);
  if (args.dryRun) console.log('(Dry run — no data was written to SQLite)');

  const sortedEntities = [...topEntities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  writeSummaryJson(args.output, {
    provider: llm.provider,
    model: llm.model,
    totalProcessed: result.totalProcessed,
    totalExtracted: result.totalSuccess,
    totalEntities,
    totalFailed: result.totalFailed,
    dryRun: args.dryRun,
    entityTypeDistribution: Object.fromEntries([...entityTypeStats.entries()].sort((a, b) => b[1] - a[1])),
    topEntities: Object.fromEntries(sortedEntities),
    timestamp: new Date().toISOString(),
  });

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
