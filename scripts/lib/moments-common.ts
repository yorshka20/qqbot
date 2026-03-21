/**
 * Shared utilities for moments batch processing scripts.
 *
 * Provides: config loading, CLI parsing, Qdrant operations, Ollama calls,
 * and a generic batch processing loop to eliminate duplication across
 * moments-tag.ts, moments-sentiment.ts, moments-ner.ts, etc.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as JSONC from 'jsonc-parser';

// ============================================================================
// Types
// ============================================================================

export interface ProviderConfig {
  type: string;
  baseUrl?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
}

export interface AppConfig {
  rag: {
    enabled: boolean;
    qdrant: { url: string; apiKey?: string };
  };
  ai: {
    providers: Record<string, ProviderConfig>;
  };
}

/** Resolved LLM connection info for batch scripts. */
export interface LLMConnection {
  provider: string; // provider key name
  type: string; // 'ollama' | 'deepseek' | 'doubao' | etc.
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface QdrantPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

export interface ScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset: string | number | null;
  };
}

export interface ParsedArgs {
  limit: number;
  dryRun: boolean;
  model: string;
  provider: string;
  batchSize: number;
  output: string;
}

// ============================================================================
// Config loading
// ============================================================================

export function loadConfig(configPath = 'config.jsonc'): AppConfig {
  const raw = readFileSync(process.env.CONFIG_PATH || configPath, 'utf-8');
  return JSONC.parse(raw) as AppConfig;
}

/** @deprecated Use resolveLLMConnection instead. Kept for backward compatibility. */
export function getOllamaBaseUrl(config: AppConfig): string {
  const conn = resolveLLMConnection(config, 'ollama');
  return conn.baseUrl;
}

/**
 * Resolve an LLM connection from config by provider key or type.
 * Lookup order: exact key match → first provider with matching type → fallback to 'ollama'.
 */
export function resolveLLMConnection(config: AppConfig, providerKey: string, modelOverride?: string): LLMConnection {
  const providers = config.ai?.providers ?? {};

  // Try exact key match first
  let entry: [string, ProviderConfig] | undefined;
  if (providers[providerKey]) {
    entry = [providerKey, providers[providerKey]];
  } else {
    // Try matching by type
    entry = Object.entries(providers).find(([, p]) => p.type === providerKey);
  }

  if (!entry) {
    throw new Error(
      `Provider "${providerKey}" not found in config. Available: ${Object.keys(providers).join(', ')}`,
    );
  }

  const [key, cfg] = entry;
  const baseUrl = (cfg.baseUrl || cfg.baseURL || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(`Provider "${key}" has no baseUrl/baseURL configured`);
  }

  return {
    provider: key,
    type: cfg.type,
    baseUrl,
    apiKey: cfg.apiKey,
    model: modelOverride || cfg.model || '',
  };
}

// ============================================================================
// CLI argument parsing
// ============================================================================

export function parseArgs(defaults: {
  model: string;
  batchSize: number;
  output: string;
  provider?: string;
}): ParsedArgs {
  const args = process.argv.slice(2);
  let limit = 0;
  let dryRun = false;
  let model = defaults.model;
  let provider = defaults.provider || 'ollama';
  let batchSize = defaults.batchSize;
  let output = defaults.output;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--provider' && args[i + 1]) {
      provider = args[i + 1];
      i++;
    } else if (args[i] === '--batch' && args[i + 1]) {
      batchSize = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  return { limit, dryRun, model, provider, batchSize, output };
}

// ============================================================================
// Qdrant operations
// ============================================================================

const COLLECTION = 'wechat_moments';

export async function qdrantScroll(
  qdrantUrl: string,
  offset: string | number | null,
  limit: number,
  options?: {
    collection?: string;
    filter?: Record<string, unknown>;
    payloadInclude?: string[];
  },
): Promise<ScrollResponse> {
  const collection = options?.collection ?? COLLECTION;
  const body: Record<string, unknown> = {
    limit,
    with_payload: options?.payloadInclude ? { include: options.payloadInclude } : true,
    with_vector: false,
  };
  if (options?.filter) body.filter = options.filter;
  if (offset != null) body.offset = offset;

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Qdrant scroll failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ScrollResponse;
}

export async function qdrantSetPayload(
  qdrantUrl: string,
  pointIds: Array<string | number>,
  payload: Record<string, unknown>,
  collection = COLLECTION,
): Promise<void> {
  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, points: pointIds }),
  });

  if (!res.ok) {
    throw new Error(`Qdrant set_payload failed: ${res.status} ${await res.text()}`);
  }
}

// ============================================================================
// LLM call (multi-provider: ollama, deepseek, doubao, openai-compatible)
// ============================================================================

/**
 * Call LLM with a batch of content items and a prompt builder.
 * Supports Ollama (/api/chat) and OpenAI-compatible providers (/v1/chat/completions).
 * Extracts JSON array from the LLM response.
 */
export async function callLLM<T>(
  conn: LLMConnection,
  contents: Array<{ index: number; content: string }>,
  promptBuilder: (contentList: string) => string,
): Promise<T[]> {
  const contentList = contents.map((c) => `[${c.index}] ${(c.content || '').slice(0, 500)}`).join('\n\n');
  const prompt = promptBuilder(contentList);

  const text = conn.type === 'ollama'
    ? await callOllamaAPI(conn, prompt)
    : await callOpenAICompatibleAPI(conn, prompt);

  return extractJsonArray<T>(text);
}

/** Ollama native API: POST /api/chat */
async function callOllamaAPI(conn: LLMConnection, prompt: string): Promise<string> {
  const res = await fetch(`${conn.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: conn.model,
      messages: [{ role: 'user', content: `${prompt}\n\n/no_think` }],
      stream: false,
      options: { num_predict: 4096, temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama call failed: ${res.status} ${await res.text()}`);
  }

  const result = (await res.json()) as { message?: { content?: string } };
  return result.message?.content ?? '';
}

/** OpenAI-compatible API: POST /v1/chat/completions (DeepSeek, Doubao, OpenAI, etc.) */
async function callOpenAICompatibleAPI(conn: LLMConnection, prompt: string): Promise<string> {
  // Doubao (Ark) uses /chat/completions without /v1 prefix; DeepSeek uses /v1/chat/completions.
  // Try to detect from baseUrl: if it already ends with /v1 or /v3, append /chat/completions directly.
  let endpoint: string;
  if (conn.baseUrl.match(/\/v\d+$/)) {
    endpoint = `${conn.baseUrl}/chat/completions`;
  } else {
    endpoint = `${conn.baseUrl}/v1/chat/completions`;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conn.apiKey) {
    headers.Authorization = `Bearer ${conn.apiKey}`;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: conn.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    throw new Error(`${conn.provider} call failed: ${res.status} ${await res.text()}`);
  }

  const result = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return result.choices?.[0]?.message?.content ?? '';
}

/** @deprecated Use callLLM instead. */
export async function callOllama<T>(
  ollamaUrl: string,
  model: string,
  contents: Array<{ index: number; content: string }>,
  promptBuilder: (contentList: string) => string,
): Promise<T[]> {
  return callLLM<T>(
    { provider: 'ollama', type: 'ollama', baseUrl: ollamaUrl, model },
    contents,
    promptBuilder,
  );
}

/** Extract a JSON array from LLM response text (handles markdown code blocks). */
export function extractJsonArray<T>(text: string): T[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse response as JSON array: ${text.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[0]) as T[];
}

// ============================================================================
// Output utilities
// ============================================================================

export function ensureOutputDir(outputPath: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appendJsonl(outputPath: string, record: unknown): void {
  appendFileSync(outputPath, `${JSON.stringify(record)}\n`);
}

export function writeSummaryJson(
  outputPath: string,
  data: Record<string, unknown>,
): void {
  const summaryPath = outputPath.replace(/\.jsonl$/, '-summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Summary file:    ${summaryPath}`);
}

export function printDistribution(stats: Map<string, number>, title: string, maxBarLength = 40): void {
  const sorted = [...stats.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return;
  console.log(`\n${title}:`);
  for (const [key, count] of sorted) {
    const bar = '█'.repeat(Math.min(count, maxBarLength));
    console.log(`  ${key.padEnd(12)} ${String(count).padStart(4)} ${bar}`);
  }
}

export function printHeader(title: string, info: Record<string, string | number | boolean>): void {
  console.log(`=== ${title} ===`);
  for (const [key, value] of Object.entries(info)) {
    console.log(`${key.padEnd(12)}${value}`);
  }
  console.log('');
}

// ============================================================================
// Generic batch processing loop
// ============================================================================

export interface BatchProcessOptions<R extends { index: number }> {
  qdrantUrl: string;
  /** LLM connection info (resolved via resolveLLMConnection). */
  llm: LLMConnection;
  batchSize: number;
  limit: number;
  output: string;
  dryRun: boolean;
  /** Qdrant scroll filter (e.g. filter for untagged records) */
  scrollFilter?: Record<string, unknown>;
  /** Which payload fields to include in the scroll response */
  payloadInclude?: string[];
  /** Build the prompt from a content list string */
  promptBuilder: (contentList: string) => string;
  /** Process one LLM result item, returning an output record to append to JSONL. */
  processResult: (result: R, point: QdrantPoint) => unknown;
  /** Set of point IDs to skip (already processed). */
  skipIds?: Set<string>;
}

export interface BatchProcessResult {
  totalProcessed: number;
  totalSkipped: number;
  totalSuccess: number;
  totalFailed: number;
}

export async function runBatchLoop<R extends { index: number }>(
  opts: BatchProcessOptions<R>,
): Promise<BatchProcessResult> {
  ensureOutputDir(opts.output);

  const skipIds = opts.skipIds;
  let offset: string | number | null = null;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let batchNum = 0;

  while (true) {
    if (opts.limit > 0 && totalProcessed >= opts.limit) break;

    const fetchCount = skipIds
      ? (opts.limit > 0 ? Math.min(opts.batchSize * 2, opts.limit - totalProcessed) : opts.batchSize * 2)
      : (opts.limit > 0 ? Math.min(opts.batchSize, opts.limit - totalProcessed) : opts.batchSize);

    const scrollRes = await qdrantScroll(opts.qdrantUrl, offset, fetchCount, {
      filter: opts.scrollFilter,
      payloadInclude: opts.payloadInclude,
    });
    const rawPoints = scrollRes.result.points;

    if (rawPoints.length === 0) {
      console.log('\nNo more records to process.');
      break;
    }

    // Filter out already-processed points
    const points = skipIds ? rawPoints.filter((p) => !skipIds.has(String(p.id))) : rawPoints;
    const skipped = rawPoints.length - points.length;
    totalSkipped += skipped;

    if (points.length === 0) {
      offset = scrollRes.result.next_page_offset;
      if (offset == null) { console.log('\nReached end of collection.'); break; }
      if (skipped > 0) console.log(`  Skipped ${skipped} already-processed, fetching next page...`);
      continue;
    }

    const batch = points.slice(0, opts.batchSize);

    batchNum++;
    if (skipped > 0) {
      console.log(`\n--- Batch ${batchNum}: ${batch.length} records (skipped ${skipped} already-processed) ---`);
    } else {
      console.log(`\n--- Batch ${batchNum}: ${batch.length} records ---`);
    }

    const contents = batch.map((p, i) => ({
      index: i,
      content: (p.payload.content as string) || '',
    }));

    try {
      const results = await callLLM<R>(opts.llm, contents, opts.promptBuilder);

      for (const r of results) {
        if (r.index < 0 || r.index >= batch.length) continue;

        const record = opts.processResult(r, batch[r.index]);
        if (record != null) {
          appendJsonl(opts.output, record);
        }
        totalSuccess++;
      }

      const returnedIndices = new Set(results.map((r) => r.index));
      for (let i = 0; i < batch.length; i++) {
        if (!returnedIndices.has(i)) {
          console.log(`  [${i}] MISSED by LLM — skipping`);
          totalFailed++;
        }
      }
    } catch (err) {
      console.error(`  Batch ${batchNum} FAILED:`, err instanceof Error ? err.message : err);
      totalFailed += batch.length;
    }

    totalProcessed += batch.length;
    offset = scrollRes.result.next_page_offset;

    console.log(`  Progress: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalSuccess} success, ${totalFailed} failed`);

    if (offset == null) {
      console.log('\nReached end of collection.');
      break;
    }
  }

  return { totalProcessed, totalSkipped, totalSuccess, totalFailed };
}
