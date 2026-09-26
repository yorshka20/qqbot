// Offline memory maintenance: migration, index rebuild, review, retrieval eval, backfill.
//
// Local batch work, not the daily routine: the running bot consolidates one day at a time
// through the same services. This builds only the DI core and the database connection
// (bootstrapCore), never startApp: startApp starts the agenda cron, the static server and
// plugins, and a long run here must not fire scheduled tasks next to the live bot.
//
// Usage: bun run memory <command> [options]
//
//   migrate --dry-run [--group a,b] [--concurrency 4]
//       Split each legacy auto.txt into atomic facts with an LLM and write a plan
//       (data/backup/memory/migrate/plan-<date>.json) plus a readable report next to it.
//   migrate --apply <plan.json>
//       Insert the plan's facts, rename each migrated auto.txt to auto.migrated.txt, export
//       and drop the legacy memory_fact_meta table, then reindex the groups.
//   reindex [--group a,b]
//       Make every memory_* collection hold exactly the active facts (drops legacy points).
//   review [--group a,b]
//       Review the due facts now, as the daily job does.
//   eval --group <id> [--user <id>] <query>
//       Print the facts a query would retrieve, with similarity and final score.
//   backfill --group <id> --since <YYYY-MM-DD>
//       Extract and consolidate a group's messages since a date.
//   stats
//       Fact counts per group and status.
//
// LLM: --provider / --model; migrate defaults to gemini / gemini-3.8-flash, the rest to the
// memory plugin's extractProvider / extractModel.

import 'reflect-metadata';

import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { LLMService } from '@/ai/services/LLMService';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { bootstrapCore } from '@/core/bootstrap';
import { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { DatabaseManager } from '@/database/DatabaseManager';
import { chunkLines } from '@/memory/extraction/chunkLines';
import { MemoryExtractService } from '@/memory/extraction/MemoryExtractService';
import { type NewFactDraft, parseDraft } from '@/memory/llm/factDraft';
import { generateMemoryJson, type MemoryLLMOptions } from '@/memory/llm/memoryLLM';
import { listManualFacts, scopeGuide } from '@/memory/llm/promptParts';
import { GROUP_MEMORY_USER_ID } from '@/memory/model/constants';
import { slotLabel } from '@/memory/model/scopes';
import { MemoryRetrievalService } from '@/memory/retrieval/MemoryRetrievalService';
import { scoreFact } from '@/memory/retrieval/scoring';
import { MemoryReviewService } from '@/memory/review/MemoryReviewService';
import { ManualMemoryStore } from '@/memory/storage/ManualMemoryStore';
import { MemoryFactStore } from '@/memory/storage/MemoryFactStore';
import { MemoryIndex } from '@/memory/storage/MemoryIndex';
import { RetrievalService } from '@/services/retrieval/RetrievalService';

const MEMORY_DIR = 'data/memory';
const MIGRATE_DIR = 'data/backup/memory/migrate';
const LEGACY_FILE = 'auto.txt';
const MIGRATED_FILE = 'auto.migrated.txt';
const BACKFILL_CHUNK_CHARS = 15_000;

// ── Args ──

const [command, ...rest] = process.argv.slice(2);

function arg(name: string): string | undefined {
  const idx = rest.indexOf(`--${name}`);
  return idx >= 0 && rest[idx + 1] && !rest[idx + 1].startsWith('--') ? rest[idx + 1] : undefined;
}

function flag(name: string): boolean {
  return rest.includes(`--${name}`);
}

function listArg(name: string): string[] {
  return (arg(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Words that are neither flags nor flag values. */
function positional(): string[] {
  return rest.filter((word, i) => !word.startsWith('--') && !rest[i - 1]?.startsWith('--'));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Boot ──

const config = new Config(process.env.CONFIG_PATH);
bootstrapCore(config);
const container = getContainer();
const databaseManager = container.resolve(DatabaseManager);
await databaseManager.initialize(config.getDatabaseConfig());

const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
const llmService = container.resolve(LLMService);
const store = container.resolve(MemoryFactStore);
const manualStore = container.resolve(ManualMemoryStore);

function llmOptions(defaults: MemoryLLMOptions): MemoryLLMOptions {
  return { provider: arg('provider') ?? defaults.provider, model: arg('model') ?? defaults.model };
}

function pluginLLMOptions(): MemoryLLMOptions {
  const plugin = config.getPluginConfig('memory') as { extractProvider?: string; extractModel?: string } | undefined;
  if (!plugin?.extractProvider) {
    throw new Error('memory plugin has no extractProvider; pass --provider');
  }
  return llmOptions({ provider: plugin.extractProvider, model: plugin.extractModel });
}

function rawDb(): Database {
  const adapter = databaseManager.getAdapter();
  const db = adapter instanceof SQLiteAdapter ? adapter.getRawDb() : null;
  if (!db) {
    throw new Error('this command needs the SQLite database');
  }
  return db;
}

async function runPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item);
    }
  });
  await Promise.all(workers);
}

// ── migrate ──

interface LegacySlot {
  groupId: string;
  userId: string;
  path: string;
  text: string;
}

interface PlannedFact extends NewFactDraft {
  firstSeen: number;
}

interface MigrationPlan {
  createdAt: string;
  llm: MemoryLLMOptions;
  slots: Array<{ groupId: string; userId: string; legacyPath: string; legacyChars: number; facts: PlannedFact[] }>;
  failed: Array<{ groupId: string; userId: string }>;
}

function legacySlots(groups: string[]): LegacySlot[] {
  if (!existsSync(MEMORY_DIR)) {
    return [];
  }
  const slots: LegacySlot[] = [];
  for (const groupEntry of readdirSync(MEMORY_DIR, { withFileTypes: true })) {
    if (!groupEntry.isDirectory() || (groups.length > 0 && !groups.includes(groupEntry.name))) {
      continue;
    }
    for (const slotEntry of readdirSync(join(MEMORY_DIR, groupEntry.name), { withFileTypes: true })) {
      const path = join(MEMORY_DIR, groupEntry.name, slotEntry.name, LEGACY_FILE);
      if (!slotEntry.isDirectory() || !existsSync(path)) {
        continue;
      }
      const text = readFileSync(path, 'utf-8').trim();
      if (text) {
        const userId = slotEntry.name === '_global_' ? GROUP_MEMORY_USER_ID : slotEntry.name;
        slots.push({ groupId: groupEntry.name, userId, path, text });
      }
    }
  }
  return slots;
}

/** Character-bigram Dice similarity, for matching a new fact to the legacy row it came from. */
function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0);
  }
  const total = Math.max(1, a.length - 1 + (b.length - 1));
  return (2 * overlap) / total;
}

function normalize(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s。！？；.!?;，,、：:"“”'‘’（）()[\]【】]+/g, ' ')
    .trim();
}

/**
 * When each new fact was first seen: the firstSeen of the legacy row it best matches, else the
 * slot's earliest legacy row, else now.
 */
function firstSeenFor(db: Database, slot: LegacySlot, facts: NewFactDraft[]): PlannedFact[] {
  const rows = db
    .query('SELECT normalizedContent, firstSeen FROM memory_fact_meta WHERE groupId = ? AND userId = ?')
    .all(slot.groupId, slot.userId) as Array<{ normalizedContent: string; firstSeen: number }>;
  const earliest = rows.length > 0 ? Math.min(...rows.map((r) => r.firstSeen)) : Date.now();
  const named = rows.filter((r) => r.normalizedContent.trim());
  return facts.map((fact) => {
    const key = normalize(fact.content);
    let best = { score: 0, firstSeen: earliest };
    for (const row of named) {
      const score = bigramSimilarity(key, row.normalizedContent);
      if (score > best.score) {
        best = { score, firstSeen: row.firstSeen };
      }
    }
    return { ...fact, firstSeen: best.score >= 0.5 ? best.firstSeen : earliest };
  });
}

async function migrateDryRun(): Promise<void> {
  const llm = llmOptions({ provider: 'gemini', model: 'gemini-3.8-flash' });
  const slots = legacySlots(listArg('group'));
  const db = rawDb();
  const plan: MigrationPlan = { createdAt: new Date().toISOString(), llm, slots: [], failed: [] };
  console.log(`Migrating ${slots.length} legacy slots with ${llm.provider}/${llm.model ?? 'default'}`);
  let done = 0;
  await runPool(slots, Number(arg('concurrency') ?? '4'), async (slot) => {
    const prompt = promptManager.render('memory.migrate', {
      slotLabel: slotLabel(slot.userId),
      scopeGuide: scopeGuide(promptManager, slot.userId),
      manualFacts: listManualFacts(manualStore.getFacts(slot.groupId, slot.userId)),
      legacyMemory: slot.text,
    });
    const answer = await generateMemoryJson(llmService, prompt, llm, 'MemoryMigrate');
    done++;
    if (!answer || !Array.isArray(answer.facts)) {
      plan.failed.push({ groupId: slot.groupId, userId: slot.userId });
      console.log(`  [${done}/${slots.length}] ${slot.groupId}/${slot.userId}: FAILED`);
      return;
    }
    const drafts = answer.facts
      .map((f) => (f && typeof f === 'object' ? parseDraft(f as Record<string, unknown>, slot.userId) : null))
      .filter((f): f is NewFactDraft => f !== null);
    plan.slots.push({
      groupId: slot.groupId,
      userId: slot.userId,
      legacyPath: slot.path,
      legacyChars: slot.text.length,
      facts: firstSeenFor(db, slot, drafts),
    });
    console.log(
      `  [${done}/${slots.length}] ${slot.groupId}/${slot.userId}: ${slot.text.length} chars → ${drafts.length} facts ` +
        `(${answer.facts.length - drafts.length} rejected)`,
    );
  });
  plan.slots.sort((a, b) => `${a.groupId}/${a.userId}`.localeCompare(`${b.groupId}/${b.userId}`));

  const base = join(MIGRATE_DIR, `plan-${today()}`);
  await mkdir(dirname(base), { recursive: true });
  await writeFile(`${base}.json`, JSON.stringify(plan, null, 2), 'utf-8');
  await writeFile(`${base}.md`, renderPlanReport(plan, slots), 'utf-8');
  const total = plan.slots.reduce((n, s) => n + s.facts.length, 0);
  console.log(`\n${plan.slots.length} slots, ${total} facts, ${plan.failed.length} failed`);
  console.log(`Plan:   ${base}.json\nReport: ${base}.md\nApply:  bun run memory migrate --apply ${base}.json`);
}

function renderPlanReport(plan: MigrationPlan, slots: LegacySlot[]): string {
  const legacy = new Map(slots.map((s) => [`${s.groupId}/${s.userId}`, s.text]));
  const parts = [
    `# Memory migration plan ${plan.createdAt}`,
    `LLM: ${plan.llm.provider}/${plan.llm.model ?? 'default'}`,
  ];
  if (plan.failed.length > 0) {
    parts.push(`Failed: ${plan.failed.map((f) => `${f.groupId}/${f.userId}`).join(', ')}`);
  }
  for (const slot of plan.slots) {
    const key = `${slot.groupId}/${slot.userId}`;
    const facts = slot.facts
      .map((f) => `- [${f.scope}] (${f.durability}, ${new Date(f.firstSeen).toISOString().slice(0, 10)}) ${f.content}`)
      .join('\n');
    parts.push(
      `## ${key} — ${slot.legacyChars} chars → ${slot.facts.length} facts\n\n### New\n${facts}\n\n` +
        `<details><summary>Legacy</summary>\n\n\`\`\`\n${legacy.get(key) ?? ''}\n\`\`\`\n</details>`,
    );
  }
  return `${parts.join('\n\n')}\n`;
}

async function migrateApply(planPath: string): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as MigrationPlan;
  const db = rawDb();
  const groups = new Set<string>();
  for (const slot of plan.slots) {
    const existing = await store.listSlot(slot.groupId, slot.userId);
    if (existing.length > 0) {
      console.log(`  ${slot.groupId}/${slot.userId}: already has ${existing.length} facts, skipped`);
      continue;
    }
    await store.add(
      slot.facts.map((fact) => ({
        groupId: slot.groupId,
        userId: slot.userId,
        scope: fact.scope,
        content: fact.content,
        durability: fact.durability,
        firstSeen: fact.firstSeen,
        lastConfirmedAt: fact.firstSeen,
        confirmCount: 1,
      })),
    );
    if (existsSync(slot.legacyPath)) {
      await rename(slot.legacyPath, join(dirname(slot.legacyPath), MIGRATED_FILE));
    }
    groups.add(slot.groupId);
    console.log(`  ${slot.groupId}/${slot.userId}: ${slot.facts.length} facts`);
  }

  const hasLegacyTable = db.query("SELECT name FROM sqlite_master WHERE name = 'memory_fact_meta'").get();
  if (hasLegacyTable) {
    const exportPath = join(MIGRATE_DIR, `memory_fact_meta-${today()}.json`);
    await writeFile(exportPath, JSON.stringify(db.query('SELECT * FROM memory_fact_meta').all(), null, 2), 'utf-8');
    db.run('DROP TABLE memory_fact_meta');
    console.log(`Legacy memory_fact_meta exported to ${exportPath} and dropped`);
  }
  await reindex([...groups]);
}

// ── reindex / review / eval / backfill / stats ──

async function reindex(onlyGroups: string[]): Promise<void> {
  const index = container.resolve(MemoryIndex);
  if (!index.isEnabled()) {
    throw new Error('rag is disabled; there is no index to rebuild');
  }
  const retrieval = container.resolve(RetrievalService);
  const fromCollections = (await retrieval.listCollections())
    .map((c) => c.name)
    .filter((name) => name.startsWith('memory_'))
    .map((name) => name.slice('memory_'.length));
  const groupIds = [...new Set([...(await store.listGroupIds()), ...fromCollections])]
    .filter((groupId) => onlyGroups.length === 0 || onlyGroups.includes(groupId))
    .sort();
  for (const groupId of groupIds) {
    const result = await store.reindexGroup(groupId);
    console.log(`  ${MemoryIndex.collectionName(groupId)}: upserted ${result.upserted}, removed ${result.removed}`);
  }
}

async function review(): Promise<void> {
  const reviewService = container.resolve(MemoryReviewService);
  const options = pluginLLMOptions();
  const groups = listArg('group');
  for (const groupId of groups.length > 0 ? groups : await store.listGroupIds()) {
    const summary = await reviewService.reviewGroup(groupId, options);
    console.log(
      `  ${groupId}: due ${summary.due}, kept ${summary.kept}, retired ${summary.retired}, merged ${summary.merged}`,
    );
  }
}

async function evaluate(): Promise<void> {
  const groupId = arg('group');
  const userId = arg('user');
  const query = positional().join(' ');
  if (!groupId || !query) {
    throw new Error('usage: eval --group <id> [--user <id>] <query>');
  }
  const index = container.resolve(MemoryIndex);
  const active = await store.listGroup(groupId, 'active');
  const byId = new Map(active.map((fact) => [fact.id, fact]));
  const hits = await index.search(groupId, query, {
    owners: userId ? { userId, includeGroup: true } : 'everyone',
    excludeCoreScopes: [],
    limit: Number(arg('limit') ?? '15'),
    minScore: 0,
  });
  const scoring = container.resolve(MemoryRetrievalService).getScoring();
  const now = Date.now();
  console.log(`query: ${query}\n  sim    final  owner          fact`);
  for (const hit of hits) {
    const fact = byId.get(hit.id);
    if (!fact) {
      console.log(`  ${hit.score.toFixed(3)}  (point ${hit.id} has no active fact)`);
      continue;
    }
    const final = scoreFact(hit.score, fact, scoring, now);
    const owner = fact.userId === GROUP_MEMORY_USER_ID ? 'group' : fact.userId;
    console.log(`  ${hit.score.toFixed(3)}  ${final.toFixed(3)}  ${owner.padEnd(13)}  [${fact.scope}] ${fact.content}`);
  }
}

async function backfill(): Promise<void> {
  const groupId = arg('group');
  const since = arg('since');
  if (!groupId || !since) {
    throw new Error('usage: backfill --group <id> --since <YYYY-MM-DD>');
  }
  const history = container.resolve(ConversationHistoryService);
  const extract = container.resolve(MemoryExtractService);
  const selfId = config.getConfig().bot.selfId;
  const entries = (await history.getMessagesSince(groupId, new Date(since), 100_000)).filter(
    (e) => String(e.userId) !== selfId,
  );
  const chunks = chunkLines(history.formatAsText(entries), BACKFILL_CHUNK_CHARS);
  console.log(`${entries.length} messages since ${since} in ${chunks.length} chunks`);
  const options = pluginLLMOptions();
  for (let i = 0; i < chunks.length; i++) {
    await extract.extractAndConsolidate(groupId, chunks[i], options);
    console.log(`  chunk ${i + 1}/${chunks.length} done`);
  }
}

async function stats(): Promise<void> {
  const counts = new Map<string, Record<string, number>>();
  for (const fact of await store.listAll()) {
    const row = counts.get(fact.groupId) ?? {};
    row[fact.status] = (row[fact.status] ?? 0) + 1;
    counts.set(fact.groupId, row);
  }
  for (const [groupId, row] of counts) {
    console.log(
      `  ${groupId}: ${Object.entries(row)
        .map(([status, n]) => `${status} ${n}`)
        .join(', ')}`,
    );
  }
  console.log(`  manual slots: ${manualStore.listSlots().length}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'migrate': {
      const planPath = arg('apply');
      if (planPath) {
        await migrateApply(planPath);
      } else if (flag('dry-run')) {
        await migrateDryRun();
      } else {
        throw new Error('migrate needs --dry-run or --apply <plan.json>');
      }
      break;
    }
    case 'reindex':
      await reindex(listArg('group'));
      break;
    case 'review':
      await review();
      break;
    case 'eval':
      await evaluate();
      break;
    case 'backfill':
      await backfill();
      break;
    case 'stats':
      await stats();
      break;
    default:
      throw new Error('commands: migrate | reindex | review | eval | backfill | stats (see file header)');
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await databaseManager.close();
}
process.exit();
