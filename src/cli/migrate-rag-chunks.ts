// Migration script: read all full-text articles from wechat_articles,
// chunk them, and write to wechat_articles_chunks.
//
// Usage: bun run src/cli/migrate-rag-chunks.ts [--dry-run] [--chunk-size 600] [--overlap 100]
//
// This is safe to re-run: chunk IDs are deterministic ({articleId}_chunk_{index}),
// so repeated runs will upsert (overwrite) the same points.

import 'reflect-metadata';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { chunkText } from '@/services/retrieval/rag/chunkText';
import { OllamaEmbedClient } from '@/services/retrieval/rag/OllamaEmbedClient';
import { QdrantClient } from '@/services/retrieval/rag/QdrantClient';

// ── Parse CLI args ──

function getArg(name: string, defaultValue: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const dryRun = process.argv.includes('--dry-run');
const chunkSize = Number(getArg('chunk-size', '600'));
const overlap = Number(getArg('overlap', '100'));

// ── Load config ──

function loadConfig() {
  const configPath = process.env.CONFIG_PATH ?? './config.jsonc';
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    console.error(`Config not found: ${resolved}`);
    process.exit(1);
  }
  const content = readFileSync(resolved, 'utf-8');
  return parseJsonc(content) as Record<string, unknown>;
}

const config = loadConfig();
const ragConfig = (config as { rag?: Record<string, unknown> }).rag as
  | {
      enabled?: boolean;
      ollama: { url: string; model: string; timeout?: number };
      qdrant: { url: string; apiKey?: string; timeout?: number };
      defaultVectorSize?: number;
      defaultDistance?: string;
    }
  | undefined;

if (!ragConfig?.enabled) {
  console.error('RAG is not enabled in config. Nothing to migrate.');
  process.exit(1);
}

const pluginsConfig = (config as { plugins?: { list?: Array<{ config?: Record<string, unknown> }> } }).plugins;
const wechatPluginConfig = pluginsConfig?.list?.find(
  (p: Record<string, unknown>) => p.name === 'wechat-ingest' || p.name === 'wechat',
)?.config as { rag?: { articleCollection?: string; chunksCollection?: string } } | undefined;

const sourceCollection = wechatPluginConfig?.rag?.articleCollection ?? 'wechat_articles';
const targetCollection = wechatPluginConfig?.rag?.chunksCollection ?? 'wechat_articles_chunks';

// ── Init clients ──

const qdrant = new QdrantClient(ragConfig.qdrant);
const ollama = new OllamaEmbedClient(ragConfig.ollama);
const vectorSize = ragConfig.defaultVectorSize ?? 2560;
const distance = ragConfig.defaultDistance ?? 'Cosine';

// ── Migration ──

async function migrate() {
  console.log('=== RAG Article Chunk Migration ===');
  console.log(`  Source collection : ${sourceCollection}`);
  console.log(`  Target collection : ${targetCollection}`);
  console.log(`  Chunk size        : ${chunkSize} chars`);
  console.log(`  Overlap           : ${overlap} chars`);
  console.log(`  Dry run           : ${dryRun}`);
  console.log('');

  // Ensure target collection
  if (!dryRun) {
    await qdrant.ensureCollection(targetCollection, { vectorSize, distance });
  }

  let totalArticles = 0;
  let totalChunks = 0;
  let skippedShort = 0;

  for await (const page of qdrant.scrollAll(sourceCollection, { limit: 50, withPayload: true })) {
    for (const point of page) {
      totalArticles++;
      const payload = point.payload ?? {};
      const content = typeof payload.content === 'string' ? payload.content : '';
      const title = typeof payload.title === 'string' ? payload.title : `point_${point.id}`;
      const articleId = String(point.id);

      if (!content) {
        console.log(`  [SKIP] No content: ${title}`);
        continue;
      }

      const chunks = chunkText(content, { chunkSize, overlap });

      if (chunks.length <= 1) {
        skippedShort++;
      }

      console.log(`  [CHUNK] "${title}" — ${content.length} chars → ${chunks.length} chunk(s)`);

      if (!dryRun) {
        // Embed all chunks in one batch
        const texts = chunks.map((c) => c.text);
        const vectors = await ollama.embed(texts);

        const points = chunks.map((chunk, i) => ({
          id: chunks.length === 1 ? articleId : `${articleId}_chunk_${chunk.index}`,
          vector: vectors[i] ?? [],
          payload: {
            ...payload,
            articleId,
            chunkIndex: chunk.index,
            totalChunks: chunks.length,
            content: chunk.text,
          },
        }));

        await qdrant.upsertPoints(targetCollection, points);
      }

      totalChunks += chunks.length;
    }
  }

  console.log('');
  console.log('=== Migration Complete ===');
  console.log(`  Articles processed : ${totalArticles}`);
  console.log(`  Skipped (short)    : ${skippedShort}`);
  console.log(`  Chunks created     : ${totalChunks}`);
  if (dryRun) {
    console.log('  (Dry run — no data was written)');
  }
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
