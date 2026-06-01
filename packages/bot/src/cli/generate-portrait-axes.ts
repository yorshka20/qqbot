// Offline generator for portrait radar axes.
//
// Reads a group's message history straight from the local SQLite `messages`
// table, summarizes the recurring themes (top terms + sample lines), asks the
// configured LLM to cluster them into N named portrait dimensions with keyword
// rules, and writes a reviewable config.d/portrait.generated.jsonc. It never
// overwrites the live portrait.jsonc — inspect the draft, then promote it.
//
// Usage:
//   bun run packages/bot/src/cli/generate-portrait-axes.ts --group <groupId> [options]
//
// Options:
//   --group <id>        Group ID to analyze (required)
//   --dims <n>          Number of radar dimensions to produce (default 6)
//   --limit <n>         Max recent group messages to scan (default 3000)
//   --samples <n>       Sample messages handed to the LLM (default 120)
//   --top <n>           Top frequent terms handed to the LLM (default 80)
//   --provider <name>   AI provider key from config.ai.providers (default: ai.defaultProviders.llm)
//   --endpoint <url>    Full chat/completions URL override (else derived from provider baseUrl)
//   --out <path>        Output path (default config.d/portrait.generated.jsonc)
//   --dry-run           Skip the LLM call; dump the assembled prompt + evidence instead

import 'reflect-metadata';

import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { loadConfigAuto } from '@/core/config/loadConfigDir';

function getArg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const groupId = getArg('group');
if (!groupId) {
  console.error('Missing --group <groupId>. See file header for usage.');
  process.exit(1);
}
const dims = Number(getArg('dims', '6'));
const limit = Number(getArg('limit', '3000'));
const sampleCount = Number(getArg('samples', '120'));
const topCount = Number(getArg('top', '80'));
const dryRun = hasFlag('dry-run');
const outPath = getArg('out', 'config.d/portrait.generated.jsonc') as string;

// ── Load config ──
const configPath = process.env.CONFIG_PATH ?? (existsSync('./config.d') ? './config.d' : './config.jsonc');
const config = loadConfigAuto(configPath) as {
  database?: { type?: string; sqlite?: { path?: string } };
  ai?: { defaultProviders?: { llm?: string }; providers?: Record<string, Record<string, unknown>> };
};

const sqlitePath = config.database?.sqlite?.path;
if (config.database?.type !== 'sqlite' || !sqlitePath) {
  console.error('This script requires a SQLite database (config.database.type=sqlite with sqlite.path).');
  process.exit(1);
}

// ── Read group messages ──
const db = new Database(sqlitePath, { readonly: true });
const rows = db
  .query(
    `SELECT content FROM messages
     WHERE messageType = 'group' AND groupId = ? AND content IS NOT NULL AND content != ''
     ORDER BY createdAt DESC LIMIT ?`,
  )
  .all(groupId, limit) as Array<{ content: string }>;
db.close();

if (rows.length === 0) {
  console.error(`No group messages found for groupId=${groupId} in ${sqlitePath}.`);
  process.exit(1);
}
console.error(`Loaded ${rows.length} messages for group ${groupId}.`);

const texts = rows.map((r) => r.content.trim()).filter((t) => t.length > 0 && !t.startsWith('/'));

// ── Term frequency (CJK bigrams + ascii words), minus trivial stopwords ──
const STOPWORDS = new Set([
  '的',
  '了',
  '是',
  '我',
  '你',
  '他',
  '她',
  '们',
  '这',
  '那',
  '就',
  '都',
  '也',
  '在',
  '吗',
  '吧',
  '啊',
  '呢',
  '哦',
  '一个',
  '什么',
  '怎么',
  '没有',
  'the',
  'a',
  'an',
  'is',
  'to',
  'of',
  'and',
  'you',
  'it',
]);

const freq = new Map<string, number>();
const bump = (term: string): void => {
  if (term.length < 2 || STOPWORDS.has(term)) return;
  freq.set(term, (freq.get(term) ?? 0) + 1);
};
for (const t of texts) {
  for (const word of t.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) ?? []) {
    bump(word);
  }
  for (const run of t.match(/[一-龥]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      bump(run.slice(i, i + 2));
    }
  }
}
const topTerms = [...freq.entries()]
  .filter(([, c]) => c >= 3)
  .sort((a, b) => b[1] - a[1])
  .slice(0, topCount)
  .map(([term, c]) => `${term}(${c})`);

// ── Evenly-spaced sample messages ──
const step = Math.max(1, Math.floor(texts.length / sampleCount));
const samples = texts.filter((_, i) => i % step === 0).slice(0, sampleCount);

// ── Assemble LLM prompt ──
const prompt = `你是一个群聊文化分析师。下面是 QQ 群（groupId=${groupId}）的高频词与样本消息。
请据此设计 ${dims} 个"个人画像雷达图"的维度（轴），每个维度反映该群的一类典型聊天主题/人设特征。

要求：
- 维度要贴合这个群的真实文化（从证据里归纳，不要套用通用模板）。
- 每个维度给 2~4 条关键词规则；每条规则是一组同类关键词 + 一个 points 权重（常见词 5~6，强信号词 7~9）。
- 关键词要能在消息中以子串匹配命中（中文短词、英文小写）。
- id 用稳定的英文小写短横线命名；name 用简洁中文（≤5字）。

只输出 JSON，格式严格如下，不要任何解释：
{"dimensions":[{"id":"tech","name":"技术浓度","rules":[{"keywords":["代码","bug"],"points":8}]}]}

【高频词】
${topTerms.join('、')}

【样本消息】
${samples.map((s) => `- ${s.slice(0, 120)}`).join('\n')}`;

if (dryRun) {
  const dump = `${outPath}.prompt.txt`;
  writeFileSync(dump, prompt, 'utf-8');
  console.error(`[dry-run] Wrote prompt + evidence to ${dump}. Run an LLM on it and assemble portrait.jsonc manually.`);
  process.exit(0);
}

// ── Resolve provider (OpenAI-compatible chat/completions) ──
const providerName = getArg('provider', config.ai?.defaultProviders?.llm);
const provider = providerName ? config.ai?.providers?.[providerName] : undefined;
if (!providerName || !provider) {
  console.error(`Provider not found. Set --provider or config.ai.defaultProviders.llm. Got: ${providerName}`);
  process.exit(1);
}
const apiKey = (provider.apiKey ?? provider.apiKeyFree) as string | undefined;
const model = provider.model as string | undefined;
const baseUrl = ((provider.baseUrl ?? provider.baseURL) as string | undefined)?.replace(/\/$/, '');
if (!apiKey || !model || !baseUrl) {
  console.error(
    `Provider "${providerName}" is missing apiKey/model/baseUrl; this script needs an OpenAI-compatible provider.`,
  );
  process.exit(1);
}
const endpoint =
  getArg('endpoint') ?? (baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`);

console.error(`Calling ${providerName} (${model}) at ${endpoint} ...`);
const resp = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    response_format: { type: 'json_object' },
  }),
});
if (!resp.ok) {
  console.error(`LLM request failed: ${resp.status} ${resp.statusText}\n${await resp.text()}`);
  process.exit(1);
}
const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
const content = json.choices?.[0]?.message?.content;
if (!content) {
  console.error('LLM returned empty content.');
  process.exit(1);
}

// ── Parse + wrap + write draft ──
let parsed: { dimensions?: unknown };
try {
  parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim());
} catch (e) {
  console.error(`Failed to parse LLM JSON: ${e}\nRaw:\n${content}`);
  process.exit(1);
}
if (!Array.isArray(parsed.dimensions) || parsed.dimensions.length === 0) {
  console.error(`LLM output has no dimensions array.\nRaw:\n${content}`);
  process.exit(1);
}

const wrapped = { portrait: { enabled: true, cooldownSeconds: 60, dimensions: parsed.dimensions } };
const header = `// Generated by generate-portrait-axes for group ${groupId}.\n// Review, then replace config.d/portrait.jsonc with these dimensions to use.\n`;
writeFileSync(outPath, `${header + JSON.stringify(wrapped, null, 2)}\n`, 'utf-8');
console.error(`Wrote ${(parsed.dimensions as unknown[]).length} dimensions to ${outPath}. Review before promoting.`);
