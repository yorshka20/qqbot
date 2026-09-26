// Re-embed Qdrant points with the configured `rag.embedding` model, in place.
//
// Every point RAGService writes carries the text it embedded as `payload.content` and
// the model as `payload.embedModel`. This walks each collection, picks the points whose
// `embedModel` is not the configured one, embeds their `content` again and upserts them
// under the same id with the same payload. Re-running is safe and resumes: points that
// already carry the current model are skipped, which also catches points a running bot
// wrote with the old model while this was in progress.
//
// Usage:
//   bun run rag:reembed [--only a,b] [--skip vk_,memory_] [--concurrency 4] [--dry-run]
//
//   --only         comma-separated collection names or name prefixes to process
//   --skip         comma-separated prefixes to leave alone (default: vk_,memory_)
//                  vk_* belongs to video-knowledge-backend; memory_* is rebuilt by `bun run memory reindex`
//   --concurrency  pages embedded in parallel (default 4)
//   --dry-run      count what would be re-embedded, write nothing

import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { loadConfigAuto } from '@/core/config/loadConfigDir';
import type { RAGConfig } from '@/core/config/types/rag';
import { EmbeddingClient } from '@/services/retrieval/rag/EmbeddingClient';
import { QdrantClient } from '@/services/retrieval/rag/QdrantClient';

const PAGE_SIZE = 128;

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function listArg(name: string, fallback: string): string[] {
  return getArg(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const dryRun = process.argv.includes('--dry-run');
const only = listArg('only', '');
const skip = listArg('skip', 'vk_,memory_');
const concurrency = Math.max(1, Number(getArg('concurrency', '4')));

const configPath = process.env.CONFIG_PATH ?? (existsSync('./config.d') ? './config.d' : './config.jsonc');
const ragConfig = (loadConfigAuto(configPath) as { rag?: RAGConfig }).rag;
if (!ragConfig?.enabled) {
  console.error('rag.enabled is false; nothing to re-embed.');
  process.exit(1);
}

const qdrant = new QdrantClient(ragConfig.qdrant);
const embedder = new EmbeddingClient(ragConfig.embedding);
const staleFilter = { must_not: [{ key: 'embedModel', match: { value: embedder.model } }] };

type Point = { id: string | number; payload?: Record<string, unknown> };

async function reembedPage(collection: string, page: Point[]): Promise<{ done: number; noContent: number }> {
  const withContent = page.filter((p) => typeof p.payload?.content === 'string' && p.payload.content.trim() !== '');
  const noContent = page.length - withContent.length;
  if (withContent.length === 0 || dryRun) {
    return { done: withContent.length, noContent };
  }
  const vectors = await embedder.embed(withContent.map((p) => p.payload?.content as string));
  await qdrant.upsertPoints(
    collection,
    withContent.map((p, i) => ({
      id: p.id,
      vector: vectors[i],
      payload: { ...p.payload, embedModel: embedder.model },
    })),
  );
  return { done: withContent.length, noContent };
}

async function reembedCollection(collection: string): Promise<void> {
  const pending = await qdrant.countPoints(collection, staleFilter);
  if (pending === 0) {
    console.log(`  ${collection}: up to date`);
    return;
  }
  const started = Date.now();
  let done = 0;
  let noContent = 0;
  const inflight = new Set<Promise<void>>();
  for await (const page of qdrant.scrollAll(collection, { limit: PAGE_SIZE, withPayload: true, filter: staleFilter })) {
    const task = reembedPage(collection, page).then((result) => {
      done += result.done;
      noContent += result.noContent;
      process.stdout.write(`\r  ${collection}: ${done}/${pending}`);
    });
    const tracked = task.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    if (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }
  }
  await Promise.all(inflight);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const note = noContent > 0 ? `, ${noContent} without payload.content left as they were` : '';
  console.log(`\r  ${collection}: ${done}/${pending} in ${seconds}s${note}`);
}

async function main(): Promise<void> {
  const selected = (await qdrant.listCollections())
    .map((c) => c.name)
    .filter((name) => only.length === 0 || only.some((o) => name === o || name.startsWith(o)))
    .filter((name) => !skip.some((prefix) => name.startsWith(prefix)))
    .sort();
  console.log(`Re-embedding with ${embedder.model}${dryRun ? ' (dry run)' : ''}: ${selected.length} collections`);
  for (const collection of selected) {
    await reembedCollection(collection);
  }
}

main().catch((err) => {
  console.error('\nre-embed failed:', err);
  process.exit(1);
});
