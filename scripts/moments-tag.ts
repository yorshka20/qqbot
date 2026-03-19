#!/usr/bin/env bun
/**
 * Moments Batch Tagging Script
 *
 * Uses local Ollama Qwen3 14B to tag and summarize WeChat moments data stored in Qdrant.
 * Results are saved to data/moments-tag-results.jsonl (one JSON per line, append mode).
 *
 * Usage:
 *   # Test with first 40 records (dry run — don't write back to Qdrant)
 *   bun scripts/moments-tag.ts --limit 40 --dry-run
 *
 *   # Test with first 40 records (write back)
 *   bun scripts/moments-tag.ts --limit 40
 *
 *   # Process all untagged records
 *   bun scripts/moments-tag.ts
 *
 *   # Use a custom model
 *   bun scripts/moments-tag.ts --model qwen3:8b
 *
 *   # Custom batch size
 *   bun scripts/moments-tag.ts --batch 10
 *
 *   # Custom output file
 *   bun scripts/moments-tag.ts --output data/my-results.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as JSONC from 'jsonc-parser';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_PATH = process.env.CONFIG_PATH || 'config.jsonc';
const COLLECTION = 'wechat_moments';
const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_OUTPUT = 'data/moments-tag-results.jsonl';

// ============================================================================
// CLI argument parsing
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; // 0 = unlimited
  let dryRun = false;
  let model = DEFAULT_MODEL;
  let batchSize = DEFAULT_BATCH_SIZE;
  let output = DEFAULT_OUTPUT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--batch' && args[i + 1]) {
      batchSize = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  return { limit, dryRun, model, batchSize, output };
}

// ============================================================================
// Config loading
// ============================================================================

interface AppConfig {
  rag: {
    enabled: boolean;
    qdrant: { url: string; apiKey?: string };
  };
  ai: {
    providers: Record<string, { type: string; baseUrl?: string; baseURL?: string; model?: string }>;
  };
}

function loadConfig(): AppConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return JSONC.parse(raw) as AppConfig;
}

function getOllamaBaseUrl(config: AppConfig): string {
  const ollamaProvider = Object.values(config.ai?.providers ?? {}).find((p) => p.type === 'ollama');
  if (!ollamaProvider?.baseUrl) {
    throw new Error('No ollama provider configured in ai.providers');
  }
  return ollamaProvider.baseUrl;
}

// ============================================================================
// Qdrant helpers
// ============================================================================

interface QdrantPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

interface ScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset: string | number | null;
  };
}

async function qdrantScroll(qdrantUrl: string, offset: string | number | null, limit: number): Promise<ScrollResponse> {
  const body: Record<string, unknown> = {
    limit,
    with_payload: true,
    with_vector: false,
    // Only fetch records that haven't been tagged yet
    filter: {
      must: [
        {
          is_empty: {
            key: 'tags',
          },
        },
      ],
    },
  };
  if (offset != null) {
    body.offset = offset;
  }

  const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Qdrant scroll failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ScrollResponse;
}

async function qdrantSetPayload(
  qdrantUrl: string,
  pointIds: Array<string | number>,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/payload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, points: pointIds }),
  });

  if (!res.ok) {
    throw new Error(`Qdrant set_payload failed: ${res.status} ${await res.text()}`);
  }
}

// ============================================================================
// Ollama LLM call
// ============================================================================

interface TagResult {
  index: number;
  tags: string[];
  summary: string;
}

// Tag definitions and normalization — shared module
import { loadTaggingPrompt, normalizeTags } from '../src/services/wechat/moments/momentsTags';

async function callOllama(
  ollamaUrl: string,
  model: string,
  contents: Array<{ index: number; content: string }>,
): Promise<TagResult[]> {
  const contentList = contents.map((c) => `[${c.index}] ${(c.content || '').slice(0, 500)}`).join('\n\n');

  // Load and render prompt from template file (prompts/analysis/wechat_moments_tag.txt)
  const prompt = loadTaggingPrompt(contentList);

  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `${prompt}\n\n/no_think` }],
      stream: false,
      options: { num_predict: 4096, temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama call failed: ${res.status} ${await res.text()}`);
  }

  const result = (await res.json()) as { message?: { content?: string } };
  const text = result.message?.content ?? '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse Ollama response as JSON array: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]) as TagResult[];
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { limit, dryRun, model, batchSize, output } = parseArgs();
  const config = loadConfig();

  if (!config.rag?.enabled) {
    console.error('RAG is not enabled in config. Exiting.');
    process.exit(1);
  }

  const qdrantUrl = config.rag.qdrant.url;
  const ollamaUrl = getOllamaBaseUrl(config);

  // Ensure output directory exists and initialize file
  const outDir = dirname(output);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.log('=== Moments Batch Tagging ===');
  console.log(`Qdrant:     ${qdrantUrl}`);
  console.log(`Ollama:     ${ollamaUrl}`);
  console.log(`Model:      ${model}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Limit:      ${limit || 'unlimited'}`);
  console.log(`Dry run:    ${dryRun}`);
  console.log(`Output:     ${output}`);
  console.log('');

  // Collect all results for final summary file
  const allResults: Array<{
    id: string | number;
    createTime: string;
    content: string;
    tags: string[];
    summary: string;
  }> = [];

  let offset: string | number | null = null;
  let totalProcessed = 0;
  let totalTagged = 0;
  let totalFailed = 0;
  let batchNum = 0;
  const tagStats = new Map<string, number>();

  while (true) {
    // Check limit
    if (limit > 0 && totalProcessed >= limit) break;

    const fetchCount = limit > 0 ? Math.min(batchSize, limit - totalProcessed) : batchSize;

    const scrollRes = await qdrantScroll(qdrantUrl, offset, fetchCount);
    const points = scrollRes.result.points;

    if (points.length === 0) {
      console.log('\nNo more untagged records to process.');
      break;
    }

    batchNum++;
    console.log(`\n--- Batch ${batchNum}: ${points.length} records ---`);

    // Prepare contents for LLM
    const contents = points.map((p, i) => ({
      index: i,
      content: (p.payload.content as string) || '',
    }));

    try {
      const tagResults = await callOllama(ollamaUrl, model, contents);

      // Map results back to points
      for (const tr of tagResults) {
        if (tr.index < 0 || tr.index >= points.length) continue;

        const point = points[tr.index];
        const rawTags = Array.isArray(tr.tags) ? tr.tags : [];
        const tags = normalizeTags(rawTags);
        const summary = typeof tr.summary === 'string' ? tr.summary : '';

        if (!dryRun) {
          await qdrantSetPayload(qdrantUrl, [point.id], { tags, summary });
        }

        // Track tag stats
        for (const tag of tags) {
          tagStats.set(tag, (tagStats.get(tag) ?? 0) + 1);
        }

        // Append to results
        const record = {
          id: point.id,
          createTime: (point.payload.create_time as string) || '',
          content: (point.payload.content as string) || '',
          tags,
          summary,
        };
        allResults.push(record);

        // Append to output file incrementally (one JSON per line)
        appendFileSync(output, JSON.stringify(record) + '\n');

        totalTagged++;
        const contentPreview = ((point.payload.content as string) || '').slice(0, 60);
        console.log(`  [${tr.index}] ${tags.join(', ')} | ${summary}`);
        console.log(`       "${contentPreview}..."`);
      }

      // Check if some items were missed by LLM
      const returnedIndices = new Set(tagResults.map((r) => r.index));
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

    console.log(`  Progress: ${totalProcessed} processed, ${totalTagged} tagged, ${totalFailed} failed`);

    if (offset == null) {
      console.log('\nReached end of collection.');
      break;
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Total tagged:    ${totalTagged}`);
  console.log(`Total failed:    ${totalFailed}`);
  console.log(`Output file:     ${output} (${allResults.length} records)`);
  if (dryRun) {
    console.log('(Dry run — no data was written to Qdrant)');
  }

  // Write summary JSON file alongside the JSONL
  const summaryPath = output.replace(/\.jsonl$/, '-summary.json');
  const sorted = [...tagStats.entries()].sort((a, b) => b[1] - a[1]);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        model,
        totalProcessed,
        totalTagged,
        totalFailed,
        dryRun,
        tagDistribution: Object.fromEntries(sorted),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Summary file:    ${summaryPath}`);

  // Tag distribution
  if (tagStats.size > 0) {
    console.log('\nTag distribution:');
    for (const [tag, count] of sorted) {
      const bar = '█'.repeat(Math.min(count, 40));
      console.log(`  ${tag.padEnd(12)} ${String(count).padStart(4)} ${bar}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
