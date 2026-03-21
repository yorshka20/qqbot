#!/usr/bin/env bun
/**
 * Memory Migration Script: Markdown -> Hierarchical Scopes -> RAG
 *
 * This script helps migrate existing markdown-based memory to the new
 * hierarchical scope format (core_scope:subtag) and then indexes to RAG.
 *
 * Usage:
 *   # Step 1: Scan existing memory files
 *   bun scripts/migrate-memory-to-rag.ts scan
 *
 *   # Step 2: Reformat a single memory file with LLM (for verification)
 *   bun scripts/migrate-memory-to-rag.ts reformat <groupId> [userId]
 *   bun scripts/migrate-memory-to-rag.ts reformat 123456789           # group memory
 *   bun scripts/migrate-memory-to-rag.ts reformat 123456789 987654321 # user memory
 *
 *   # Step 3: Save reformatted memory back (after verification)
 *   bun scripts/migrate-memory-to-rag.ts save <groupId> [userId]
 *
 *   # Step 4: Index to RAG (after saving)
 *   bun scripts/migrate-memory-to-rag.ts rag <groupId> [userId]
 *   bun scripts/migrate-memory-to-rag.ts rag-all <groupId>  # index all files for a group
 *
 *   # Or do all steps at once for a group (reformat all -> save all -> index all)
 *   bun scripts/migrate-memory-to-rag.ts migrate-all <groupId>
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as JSONC from 'jsonc-parser';
import { v5 as uuidv5 } from 'uuid';

// ============================================================================
// Configuration
// ============================================================================

const MEMORY_DIR = 'data/memory';
const MIGRATION_OUTPUT_DIR = 'data/memory_migration';
const GROUP_MEMORY_FILENAME = '_global_.txt';
const CONFIG_PATH = process.env.CONFIG_PATH || 'config.jsonc';

// Core scopes (must match src/core/config/types/memory.ts)
const USER_CORE_SCOPES = ['identity', 'preference', 'opinion', 'relationship', 'behavior', 'instruction'] as const;
const GROUP_CORE_SCOPES = ['topic', 'rule', 'event', 'context'] as const;

// Scope descriptions for LLM prompt
const USER_SCOPE_DESCRIPTIONS: Record<string, string> = {
  identity: '用户主动陈述的基本属性（职业、所在地、设备等）',
  preference: '用户明确且清晰表达的长期偏好或厌恶',
  opinion: '用户说出口的观点，需有明确评价或论点',
  relationship: '用户提到的重要人物或社会关系',
  behavior: '用户的行为习惯、作息规律等',
  instruction: '用户对 bot 提出的持续性、可复用的明确要求',
};

const GROUP_SCOPE_DESCRIPTIONS: Record<string, string> = {
  topic: '在对话中反复出现的持续性主题方向',
  rule: 'bot 的群级行为设定、群公告、群规、管理员权限说明',
  event: '群内发生的重要事件',
  context: '群的背景信息、环境设定',
};

// ============================================================================
// Types
// ============================================================================

interface MemoryFile {
  groupId: string;
  userId: string | null; // null = group memory
  filePath: string;
  content: string;
}

interface LLMConfig {
  provider: 'doubao' | 'deepseek';
  apiKey: string;
  baseURL: string;
  model: string;
}

interface RAGConfig {
  enabled: boolean;
  ollama: {
    url: string;
    model: string;
    timeout?: number;
  };
  qdrant: {
    url: string;
    apiKey?: string;
    timeout?: number;
  };
  defaultVectorSize?: number;
  defaultDistance?: string;
}

interface MemoryFact {
  scope: string;
  coreScope: string;
  subtag?: string;
  content: string;
  index: number;
}

interface MemorySection {
  scope: string;
  content: string;
}

// ============================================================================
// Config Loading
// ============================================================================

function loadLLMConfig(): LLMConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const configContent = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSONC.parse(configContent) as Record<string, unknown>;

  const aiConfig = config.ai as Record<string, unknown> | undefined;
  const providers = aiConfig?.providers as Record<string, unknown> | undefined;

  // Try Doubao first, then DeepSeek
  // const doubaoConfig = providers?.doubao as Record<string, unknown> | undefined;
  // if (doubaoConfig?.apiKey) {
  //   return {
  //     provider: 'doubao',
  //     apiKey: doubaoConfig.apiKey as string,
  //     baseURL: (doubaoConfig.baseURL as string) || 'https://ark.cn-beijing.volces.com/api/v3',
  //     model: (doubaoConfig.model as string) || 'doubao-seed-1-6-lite-251015',
  //   };
  // }

  const deepseekConfig = providers?.deepseek as Record<string, unknown> | undefined;
  if (deepseekConfig?.apiKey) {
    return {
      provider: 'deepseek',
      apiKey: deepseekConfig.apiKey as string,
      baseURL: (deepseekConfig.baseURL as string) || 'https://api.deepseek.com',
      model: (deepseekConfig.model as string) || 'deepseek-chat',
    };
  }

  throw new Error('Neither Doubao nor DeepSeek config found in config.jsonc');
}

function loadRAGConfig(): RAGConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const configContent = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSONC.parse(configContent) as Record<string, unknown>;

  const ragConfig = config.rag as Record<string, unknown> | undefined;

  if (!ragConfig || !ragConfig.enabled) {
    throw new Error('RAG is not enabled in config.jsonc');
  }

  const ollama = ragConfig.ollama as Record<string, unknown> | undefined;
  const qdrant = ragConfig.qdrant as Record<string, unknown> | undefined;

  if (!ollama || !qdrant) {
    throw new Error('RAG ollama/qdrant config missing in config.jsonc');
  }

  return {
    enabled: ragConfig.enabled as boolean,
    ollama: {
      url: (ollama.url as string) || 'http://localhost:11434',
      model: (ollama.model as string) || 'qwen3-embedding:4b',
      timeout: (ollama.timeout as number) || 30000,
    },
    qdrant: {
      url: (qdrant.url as string) || 'http://localhost:6333',
      apiKey: qdrant.apiKey as string | undefined,
      timeout: (qdrant.timeout as number) || 30000,
    },
    defaultVectorSize: (ragConfig.defaultVectorSize as number) || 2560,
    defaultDistance: (ragConfig.defaultDistance as string) || 'Cosine',
  };
}

// ============================================================================
// Memory File Operations
// ============================================================================

function scanMemoryFiles(): MemoryFile[] {
  const basePath = join(process.cwd(), MEMORY_DIR);
  if (!existsSync(basePath)) {
    console.log(`Memory directory not found: ${basePath}`);
    return [];
  }

  const files: MemoryFile[] = [];
  const groupDirs = readdirSync(basePath);

  for (const groupId of groupDirs) {
    const groupPath = join(basePath, groupId);
    if (!statSync(groupPath).isDirectory()) continue;

    const memoryFiles = readdirSync(groupPath);
    for (const filename of memoryFiles) {
      if (!filename.endsWith('.txt')) continue;

      const filePath = join(groupPath, filename);
      const content = readFileSync(filePath, 'utf-8');

      if (filename === GROUP_MEMORY_FILENAME) {
        files.push({ groupId, userId: null, filePath, content });
      } else {
        const userId = filename.replace('.txt', '');
        files.push({ groupId, userId, filePath, content });
      }
    }
  }

  return files;
}

function getMemoryFilePath(groupId: string, userId: string | null): string {
  const filename = userId ? `${userId}.txt` : GROUP_MEMORY_FILENAME;
  return join(process.cwd(), MEMORY_DIR, groupId, filename);
}

function getMigrationOutputPath(groupId: string, userId: string | null): string {
  const filename = userId ? `${userId}.txt` : GROUP_MEMORY_FILENAME;
  return join(process.cwd(), MIGRATION_OUTPUT_DIR, groupId, filename);
}

function readMemoryFile(groupId: string, userId: string | null): string | null {
  const filePath = getMemoryFilePath(groupId, userId);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

async function saveMigrationOutput(groupId: string, userId: string | null, content: string): Promise<string> {
  const outputPath = getMigrationOutputPath(groupId, userId);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf-8');
  return outputPath;
}

async function saveToOriginalPath(groupId: string, userId: string | null, content: string): Promise<string> {
  const filePath = getMemoryFilePath(groupId, userId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// RAG Operations (Embedding + Qdrant)
// ============================================================================

const RAG_POINT_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace for UUID v5

function normalizeL2(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

function toQdrantPointId(id: string): string {
  // Convert arbitrary string to deterministic UUID v5
  return uuidv5(id, RAG_POINT_ID_NAMESPACE);
}

function getCollectionName(groupId: string): string {
  const safeGroupId = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `memory_${safeGroupId}`;
}

function generateFactId(groupId: string, userId: string, scope: string, index: number): string {
  const safeGroupId = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeUserId = userId.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeScope = scope.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${safeGroupId}_${safeUserId}_${safeScope}_${index}`;
}

async function embedTexts(config: RAGConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const url = `${config.ollama.url.replace(/\/$/, '')}/api/embed`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embed error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { embeddings: number[][] };
  return (data.embeddings ?? []).map((vec) => normalizeL2(vec));
}

async function ensureQdrantCollection(config: RAGConfig, collection: string): Promise<void> {
  const url = `${config.qdrant.url.replace(/\/$/, '')}/collections/${collection}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) {
    headers['api-key'] = config.qdrant.apiKey;
  }

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        vectors: {
          size: config.defaultVectorSize ?? 2560,
          distance: config.defaultDistance ?? 'Cosine',
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      // Ignore "already exists" errors
      if (!text.toLowerCase().includes('already exists') && response.status !== 409) {
        throw new Error(`Qdrant create collection error: ${response.status} ${text}`);
      }
    }
    console.log(`Collection ${collection} ensured`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (!err.message.includes('already exists')) {
      throw err;
    }
  }
}

async function upsertToQdrant(
  config: RAGConfig,
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
): Promise<void> {
  if (points.length === 0) return;

  const url = `${config.qdrant.url.replace(/\/$/, '')}/collections/${collection}/points`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) {
    headers['api-key'] = config.qdrant.apiKey;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      points: points.map((p) => ({
        id: toQdrantPointId(p.id),
        vector: p.vector,
        payload: p.payload,
      })),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qdrant upsert error: ${response.status} ${text}`);
  }

  console.log(`Upserted ${points.length} points to ${collection}`);
}

// ============================================================================
// Memory Parsing & Fact Splitting
// ============================================================================

function parseScope(scopeStr: string): { core: string; subtag?: string; full: string } {
  const normalized = scopeStr.trim().toLowerCase();
  const colonIndex = normalized.indexOf(':');

  if (colonIndex === -1) {
    return { core: normalized, full: normalized };
  }

  const core = normalized.slice(0, colonIndex);
  const subtag = normalized.slice(colonIndex + 1);
  return { core, subtag: subtag || undefined, full: normalized };
}

function parseMemorySections(memoryText: string): MemorySection[] {
  if (!memoryText.trim()) return [];

  const sections: MemorySection[] = [];
  // Match [scope] or [scope:subtag] followed by content until next [scope] or end
  const sectionRegex = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\[|\s*$)/g;
  const matches = memoryText.matchAll(sectionRegex);

  for (const match of matches) {
    const scopeStr = match[1].trim();
    const content = match[2].trim();
    if (content) {
      sections.push({ scope: scopeStr, content });
    }
  }

  return sections;
}

function splitIntoFacts(scope: string, content: string): MemoryFact[] {
  if (!content.trim()) return [];

  const parsed = parseScope(scope);

  // Split by sentence-ending punctuation (Chinese and English)
  const sentences = content
    .split(/(?<=[。！？；.!?;])\s*/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);

  if (sentences.length === 0) {
    return [
      {
        scope: parsed.full,
        coreScope: parsed.core,
        subtag: parsed.subtag,
        content: content.trim(),
        index: 0,
      },
    ];
  }

  return sentences.map((sentence: string, index: number) => ({
    scope: parsed.full,
    coreScope: parsed.core,
    subtag: parsed.subtag,
    content: sentence,
    index,
  }));
}

async function indexMemoryToRAG(
  ragConfig: RAGConfig,
  groupId: string,
  userId: string | null,
  memoryContent: string,
): Promise<number> {
  const actualUserId = userId ?? '_global_memory_';
  const isGroupMemory = userId === null;
  const collection = getCollectionName(groupId);

  // Parse memory into sections
  const sections = parseMemorySections(memoryContent);
  if (sections.length === 0) {
    console.log('No sections found in memory content');
    return 0;
  }

  // Split sections into facts
  const allFacts: MemoryFact[] = [];
  for (const section of sections) {
    const facts = splitIntoFacts(section.scope, section.content);
    allFacts.push(...facts);
  }

  if (allFacts.length === 0) {
    console.log('No facts extracted from sections');
    return 0;
  }

  console.log(`Extracted ${allFacts.length} facts from ${sections.length} sections`);

  // Ensure collection exists
  await ensureQdrantCollection(ragConfig, collection);

  // Embed all facts (with scope prefix for better semantic matching)
  const textsToEmbed = allFacts.map((f) => `[${f.scope}] ${f.content}`);
  console.log(`Embedding ${textsToEmbed.length} texts...`);
  const vectors = await embedTexts(ragConfig, textsToEmbed);

  // Build points for Qdrant
  const points = allFacts.map((fact, i) => ({
    id: generateFactId(groupId, actualUserId, fact.scope, fact.index),
    vector: vectors[i] ?? [],
    payload: {
      groupId,
      userId: actualUserId,
      scope: fact.scope,
      coreScope: fact.coreScope,
      subtag: fact.subtag,
      isGroupMemory,
      factContent: fact.content,
      factIndex: fact.index,
      content: `[${fact.scope}] ${fact.content}`,
    },
  }));

  // Upsert to Qdrant
  await upsertToQdrant(ragConfig, collection, points);

  return points.length;
}

// ============================================================================
// LLM Integration (Doubao / DeepSeek - OpenAI-compatible API)
// ============================================================================

async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${config.baseURL.replace(/\/$/, '')}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 8192,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${config.provider} API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

// ============================================================================
// Reformat Prompt (Similar to analyze.txt)
// ============================================================================

function buildReformatPrompt(memoryType: 'user' | 'global', existingContent: string): string {
  const coreScopes = memoryType === 'user' ? USER_CORE_SCOPES : GROUP_CORE_SCOPES;
  const scopeDescriptions = memoryType === 'user' ? USER_SCOPE_DESCRIPTIONS : GROUP_SCOPE_DESCRIPTIONS;

  const scopeDescStr = coreScopes.map((s) => `- \`${s}\`：${scopeDescriptions[s] ?? ''}`).join('\n');
  const coreScopesStr = coreScopes.join(' / ');

  const availableScopesSection =
    memoryType === 'user'
      ? `**user 记忆可用**：${coreScopesStr}
⚠️ user 记忆中不能包含 \`rule\`。若内容涉及群规或 bot 行为规则，直接丢弃。`
      : `**global 记忆可用**：${coreScopesStr}
\`rule\` 只能存在于 global 记忆中，记录 bot 的群级行为设定、群公告等。`;

  return `你是一个记忆整理助手。请将以下记忆内容重新整理，使用正确的层级 scope 格式。

## 当前记忆类型
${memoryType}

## 原始记忆内容
${existingContent}

---

## Scope 格式说明

scope 采用分层格式：\`core_scope\` 或 \`core_scope:subtag\`
- **core_scope**：核心分类（必须是下方列出的固定类型）
- **subtag**：可选的细分标签（用于更精确的分类）

### 可用核心 scope

${availableScopesSection}

${scopeDescStr}

### Scope 命名规则
1. subtag 使用英文 snake_case，如 \`preference:food\`、\`identity:work\`
2. 语义相近的内容归入同一 scope，不要创建过多细分
3. 如果内容不需要细分，直接使用 core_scope 即可

---

## 记忆格式说明
每个 scope 用自然语言段落描述，供其他 LLM 直接阅读。
不使用 bullet 列表，同一 scope 内的内容写成连贯的段落或句群。

---

## 处理流程

1. **识别现有信息**：理解原始记忆中的所有事实
2. **分类归属**：将每条事实归入最合适的 scope（核心或带 subtag）
3. **去重合并**：语义相同的内容合并，保留最完整的表述
4. **丢弃无效内容**：
   - 临时性、一次性的请求或状态
   - 与当前记忆类型不匹配的内容（如 user 记忆中的 rule）
   - 无法确定归属的模糊信息

---

## 输出格式
按 scope 分组，每个 scope 写一段自然语言，无内容的 scope 省略。
只输出记忆内容本身，不要任何解释或注释。

格式示例：
\`\`\`
[core_scope]
段落内容

[core_scope:subtag]
段落内容
\`\`\`

如：
\`\`\`
[identity]
用户是一名软件工程师，在北京工作。

[preference:food]
喜欢吃川菜，尤其是麻辣口味。不吃香菜。

[preference:music]
喜欢听摇滚乐和电子音乐。
\`\`\``;
}

// ============================================================================
// Main Functions
// ============================================================================

async function reformatMemory(groupId: string, userId: string | null, llmConfig: LLMConfig): Promise<string | null> {
  const content = readMemoryFile(groupId, userId);
  if (!content || !content.trim()) {
    console.log(`No content found for group=${groupId} user=${userId ?? 'GROUP'}`);
    return null;
  }

  const memoryType = userId ? 'user' : 'global';
  console.log(`\nReformatting ${memoryType} memory for group=${groupId} user=${userId ?? 'GROUP'}...`);
  console.log(`Original content length: ${content.length} chars`);

  const systemPrompt = '你是一个专业的记忆整理助手，擅长将杂乱的记忆内容重新组织成结构化的格式。';
  const userPrompt = buildReformatPrompt(memoryType, content);

  try {
    const reformatted = await callLLM(llmConfig, systemPrompt, userPrompt);
    console.log(`Reformatted content length: ${reformatted.length} chars`);
    return reformatted.trim();
  } catch (error) {
    console.error(`Failed to reformat: ${error}`);
    return null;
  }
}

// ============================================================================
// CLI Commands
// ============================================================================

async function cmdScan(): Promise<void> {
  console.log('Scanning memory files...\n');
  const files = scanMemoryFiles();

  if (files.length === 0) {
    console.log('No memory files found.');
    return;
  }

  console.log(`Found ${files.length} memory files:\n`);

  // Group by groupId
  const byGroup = new Map<string, MemoryFile[]>();
  for (const f of files) {
    const list = byGroup.get(f.groupId) || [];
    list.push(f);
    byGroup.set(f.groupId, list);
  }

  for (const [groupId, groupFiles] of byGroup) {
    console.log(`Group: ${groupId}`);
    for (const f of groupFiles) {
      const label = f.userId ? `  User ${f.userId}` : '  [GROUP MEMORY]';
      console.log(`${label}: ${f.content.length} chars`);
    }
    console.log('');
  }
}

async function cmdReformat(groupId: string, userId: string | null): Promise<void> {
  const llmConfig = loadLLMConfig();
  console.log(`Using ${llmConfig.provider}: model=${llmConfig.model}`);

  const reformatted = await reformatMemory(groupId, userId, llmConfig);

  if (reformatted) {
    console.log('\n--- Reformatted Content ---\n');
    console.log(reformatted);
    console.log('\n--- End ---\n');

    // Save to migration output dir for review
    const outputPath = await saveMigrationOutput(groupId, userId, reformatted);
    console.log(`Saved to: ${outputPath}`);
    console.log('Review the output, then run "save" command to apply changes.');
  }
}

async function cmdSave(groupId: string, userId: string | null): Promise<void> {
  const migrationPath = getMigrationOutputPath(groupId, userId);

  if (!existsSync(migrationPath)) {
    console.error(`No migration output found at: ${migrationPath}`);
    console.error('Run "reformat" command first.');
    return;
  }

  const content = readFileSync(migrationPath, 'utf-8');
  const savedPath = await saveToOriginalPath(groupId, userId, content);
  console.log(`Saved reformatted memory to: ${savedPath}`);
}

async function cmdRag(groupId: string, userId: string | null): Promise<void> {
  const ragConfig = loadRAGConfig();
  console.log(`Using RAG: Ollama=${ragConfig.ollama.url} model=${ragConfig.ollama.model}`);
  console.log(`           Qdrant=${ragConfig.qdrant.url}`);

  const content = readMemoryFile(groupId, userId);
  if (!content || !content.trim()) {
    console.error(`No memory content found for group=${groupId} user=${userId ?? 'GROUP'}`);
    return;
  }

  console.log(`\nIndexing ${userId ? 'user' : 'group'} memory for group=${groupId} user=${userId ?? 'GROUP'}...`);
  console.log(`Content length: ${content.length} chars`);

  try {
    const count = await indexMemoryToRAG(ragConfig, groupId, userId, content);
    console.log(`\nSuccessfully indexed ${count} facts to RAG!`);
  } catch (error) {
    console.error('Failed to index to RAG:', error);
  }
}

async function cmdRagAll(groupId: string): Promise<void> {
  const files = scanMemoryFiles().filter((f) => f.groupId === groupId);

  if (files.length === 0) {
    console.log(`No memory files found for group ${groupId}`);
    return;
  }

  const ragConfig = loadRAGConfig();
  console.log(`Using RAG: Ollama=${ragConfig.ollama.url} model=${ragConfig.ollama.model}`);
  console.log(`           Qdrant=${ragConfig.qdrant.url}`);
  console.log(`Found ${files.length} memory files for group ${groupId}\n`);

  let totalFacts = 0;

  for (const file of files) {
    console.log(`\nIndexing ${file.userId ? `user ${file.userId}` : 'GROUP'}...`);

    try {
      const count = await indexMemoryToRAG(ragConfig, groupId, file.userId, file.content);
      totalFacts += count;
      console.log(`Indexed ${count} facts`);
    } catch (error) {
      console.error(`Failed to index ${file.userId ?? 'GROUP'}:`, error);
    }
  }

  console.log(`\n=== Total: ${totalFacts} facts indexed ===`);
}

/**
 * Delete all existing facts for a user from Qdrant before re-indexing.
 */
async function deleteUserFactsFromQdrant(
  config: RAGConfig,
  collection: string,
  groupId: string,
  userId: string,
): Promise<void> {
  const url = `${config.qdrant.url.replace(/\/$/, '')}/collections/${collection}/points/delete`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) {
    headers['api-key'] = config.qdrant.apiKey;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filter: {
        must: [
          { key: 'groupId', match: { value: groupId } },
          { key: 'userId', match: { value: userId } },
        ],
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    // Don't throw on "not found" - collection may not exist yet
    if (!text.toLowerCase().includes('not found') && response.status !== 404) {
      throw new Error(`Qdrant delete error: ${response.status} ${text}`);
    }
  }
  console.log(`Deleted old facts for ${userId} from ${collection}`);
}

/**
 * Index from migration directory: reads from data/memory_migration/<groupId>/
 * Deletes old facts before inserting to prevent orphans.
 */
async function cmdRagMigration(groupId: string): Promise<void> {
  const migrationDir = join(process.cwd(), MIGRATION_OUTPUT_DIR, groupId);

  if (!existsSync(migrationDir)) {
    console.error(`Migration directory not found: ${migrationDir}`);
    return;
  }

  const files = readdirSync(migrationDir).filter((f) => f.endsWith('.txt'));
  if (files.length === 0) {
    console.log(`No .txt files found in ${migrationDir}`);
    return;
  }

  const ragConfig = loadRAGConfig();
  console.log(`Using RAG: Ollama=${ragConfig.ollama.url} model=${ragConfig.ollama.model}`);
  console.log(`           Qdrant=${ragConfig.qdrant.url}`);
  console.log(`Found ${files.length} memory files in migration dir\n`);

  const collection = getCollectionName(groupId);
  await ensureQdrantCollection(ragConfig, collection);

  let totalFacts = 0;

  for (const filename of files) {
    const filePath = join(migrationDir, filename);
    const content = readFileSync(filePath, 'utf-8');

    if (!content.trim()) {
      console.log(`Skipping empty file: ${filename}`);
      continue;
    }

    const isGroup = filename === GROUP_MEMORY_FILENAME;
    const userId = isGroup ? null : filename.replace('.txt', '');
    const actualUserId = userId ?? '_global_memory_';
    const label = isGroup ? 'GROUP' : `user ${userId}`;

    console.log(`\nProcessing ${label}...`);

    try {
      // Delete old facts first
      await deleteUserFactsFromQdrant(ragConfig, collection, groupId, actualUserId);

      // Index new facts
      const count = await indexMemoryToRAG(ragConfig, groupId, userId, content);
      totalFacts += count;
      console.log(`Indexed ${count} facts for ${label}`);
    } catch (error) {
      console.error(`Failed to index ${label}:`, error);
    }
  }

  console.log(`\n=== Total: ${totalFacts} facts indexed from migration dir ===`);
}

async function cmdMigrateAll(groupId: string): Promise<void> {
  const files = scanMemoryFiles().filter((f) => f.groupId === groupId);

  if (files.length === 0) {
    console.log(`No memory files found for group ${groupId}`);
    return;
  }

  const llmConfig = loadLLMConfig();
  console.log(`Using ${llmConfig.provider}: model=${llmConfig.model}`);
  console.log(`Found ${files.length} memory files for group ${groupId}\n`);

  for (const file of files) {
    const reformatted = await reformatMemory(groupId, file.userId, llmConfig);

    if (reformatted) {
      const outputPath = await saveMigrationOutput(groupId, file.userId, reformatted);
      console.log(`Saved migration output to: ${outputPath}`);
    }
  }

  console.log('\nMigration outputs saved. Review them in data/memory_migration/');
  console.log('Then run individual "save" commands to apply changes.');
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'scan':
      await cmdScan();
      break;

    case 'reformat': {
      const groupId = args[1];
      const userId = args[2] || null;
      if (!groupId) {
        console.error('Usage: reformat <groupId> [userId]');
        process.exit(1);
      }
      await cmdReformat(groupId, userId);
      break;
    }

    case 'save': {
      const groupId = args[1];
      const userId = args[2] || null;
      if (!groupId) {
        console.error('Usage: save <groupId> [userId]');
        process.exit(1);
      }
      await cmdSave(groupId, userId);
      break;
    }

    case 'rag': {
      const groupId = args[1];
      const userId = args[2] || null;
      if (!groupId) {
        console.error('Usage: rag <groupId> [userId]');
        process.exit(1);
      }
      await cmdRag(groupId, userId);
      break;
    }

    case 'rag-all': {
      const groupId = args[1];
      if (!groupId) {
        console.error('Usage: rag-all <groupId>');
        process.exit(1);
      }
      await cmdRagAll(groupId);
      break;
    }

    case 'migrate-all': {
      const groupId = args[1];
      if (!groupId) {
        console.error('Usage: migrate-all <groupId>');
        process.exit(1);
      }
      await cmdMigrateAll(groupId);
      break;
    }

    case 'rag-migration': {
      const groupId = args[1];
      if (!groupId) {
        console.error('Usage: rag-migration <groupId>');
        process.exit(1);
      }
      await cmdRagMigration(groupId);
      break;
    }

    default:
      console.log(`Memory Migration Script

Usage:
  bun scripts/migrate-memory-to-rag.ts <command> [args]

Commands:
  scan                         Scan and list all memory files
  reformat <groupId> [userId]  Reformat memory with LLM (preview in data/memory_migration/)
  save <groupId> [userId]      Save reformatted memory to original location
  rag <groupId> [userId]       Index a single memory file to RAG (from data/memory/)
  rag-all <groupId>            Index all memory files for a group to RAG (from data/memory/)
  rag-migration <groupId>      Index all files from data/memory_migration/ to RAG (delete old + insert)
  migrate-all <groupId>        Reformat all memory files for a group (preview only)

Workflow:
  1. scan                       - See what memory files exist
  2. reformat <groupId>         - LLM reformats to hierarchical scopes (saved to data/memory_migration/)
  3. Review the output in data/memory_migration/
  4. rag-migration <groupId>    - Index migration output directly to RAG (deletes old facts first)

Examples:
  bun scripts/migrate-memory-to-rag.ts scan
  bun scripts/migrate-memory-to-rag.ts reformat 123456789
  bun scripts/migrate-memory-to-rag.ts rag-migration 123456789
`);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
