#!/usr/bin/env bun
/**
 * Moments Batch Tagging Script
 *
 * Uses LLM to tag and summarize WeChat moments data stored in Qdrant.
 * Results are saved to data/moments-tag-results.jsonl (one JSON per line, append mode).
 *
 * Usage:
 *   # Test with first 40 records (dry run — don't write back to Qdrant)
 *   bun scripts/moments/moments-tag.ts --limit 40 --dry-run
 *
 *   # Process all untagged records (default: ollama)
 *   bun scripts/moments/moments-tag.ts
 *
 *   # Use a different provider
 *   bun scripts/moments/moments-tag.ts --provider deepseek
 *   bun scripts/moments/moments-tag.ts --provider doubao
 *
 *   # Use a custom model
 *   bun scripts/moments/moments-tag.ts --model qwen3:8b
 */

import { loadTaggingPrompt, normalizeTags } from '../../src/services/wechat/moments/momentsTags';
import {
  loadConfig,
  parseArgs,
  printDistribution,
  printHeader,
  type QdrantPoint,
  qdrantSetPayload,
  resolveLLMConnection,
  runBatchLoop,
  writeSummaryJson,
} from '../../../scripts/lib/moments-common';

const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_OUTPUT = 'data/moments-tag-results.jsonl';

interface TagResult {
  index: number;
  tags: string[];
  summary: string;
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
  const tagStats = new Map<string, number>();

  printHeader('Moments Batch Tagging', {
    'Qdrant:': qdrantUrl,
    'Provider:': `${llm.provider} (${llm.type})`,
    'Model:': llm.model,
    'Batch size:': args.batchSize,
    'Limit:': args.limit || 'unlimited',
    'Dry run:': args.dryRun,
    'Output:': args.output,
  });

  const result = await runBatchLoop<TagResult>({
    qdrantUrl,
    llm,
    batchSize: args.batchSize,
    limit: args.limit,
    output: args.output,
    dryRun: args.dryRun,
    scrollFilter: { must: [{ is_empty: { key: 'tags' } }] },
    promptBuilder: loadTaggingPrompt,
    processResult: (tr: TagResult, point: QdrantPoint) => {
      const rawTags = Array.isArray(tr.tags) ? tr.tags : [];
      const tags = normalizeTags(rawTags);
      const summary = typeof tr.summary === 'string' ? tr.summary : '';

      if (!args.dryRun) {
        qdrantSetPayload(qdrantUrl, [point.id], { tags, summary });
      }

      for (const tag of tags) {
        tagStats.set(tag, (tagStats.get(tag) ?? 0) + 1);
      }

      const contentPreview = ((point.payload.content as string) || '').slice(0, 60);
      console.log(`  [${tr.index}] ${tags.join(', ')} | ${summary}`);
      console.log(`       "${contentPreview}..."`);

      return {
        id: point.id,
        createTime: (point.payload.create_time as string) || '',
        content: (point.payload.content as string) || '',
        tags,
        summary,
      };
    },
  });

  console.log('\n=== Summary ===');
  console.log(`Total processed: ${result.totalProcessed}`);
  console.log(`Total tagged:    ${result.totalSuccess}`);
  console.log(`Total failed:    ${result.totalFailed}`);
  console.log(`Output file:     ${args.output}`);
  if (args.dryRun) console.log('(Dry run — no data was written to Qdrant)');

  writeSummaryJson(args.output, {
    provider: llm.provider,
    model: llm.model,
    totalProcessed: result.totalProcessed,
    totalTagged: result.totalSuccess,
    totalFailed: result.totalFailed,
    dryRun: args.dryRun,
    tagDistribution: Object.fromEntries([...tagStats.entries()].sort((a, b) => b[1] - a[1])),
    timestamp: new Date().toISOString(),
  });

  printDistribution(tagStats, 'Tag distribution');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
