#!/usr/bin/env bun
/**
 * Memory Cleanup Script: uses LLM to deduplicate and clean existing auto.txt files.
 *
 * For each auto.txt:
 * 1. Reads content
 * 2. Calls LLM to deduplicate, simplify, and merge redundant entries
 * 3. Outputs to data/memory_cleanup_preview/ for human review
 * 4. After review, applies changes back to auto.txt
 *
 * Usage:
 *   # Preview a single user
 *   bun scripts/migration/cleanup-memory-with-llm.ts preview <groupId> [userId]
 *
 *   # Preview all users in a group
 *   bun scripts/migration/cleanup-memory-with-llm.ts preview-all <groupId>
 *
 *   # Apply previewed changes
 *   bun scripts/migration/cleanup-memory-with-llm.ts apply <groupId> [userId]
 *
 * Options:
 *   --provider <key>  - Provider key in config (default: deepseek)
 *   --model <name>    - Override model name
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveLLMConnection } from '../../../scripts/lib/moments-common';

const MEMORY_DIR = process.env.MEMORY_DIR || 'data/memory';
const PREVIEW_DIR = 'data/memory_cleanup_preview';

// Parse --provider and --model from argv
function parseLLMArgs(): { provider: string; model?: string } {
  const args = process.argv.slice(2);
  let provider = 'deepseek';
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      provider = args[i + 1];
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    }
  }
  return { provider, model };
}

const llmArgs = parseLLMArgs();
const config = loadConfig();
const llmConn = resolveLLMConnection(config, llmArgs.provider, llmArgs.model);

const CLEANUP_PROMPT = `你是一个记忆整理助手。以下是一个用户/群组的现有记忆，请执行以下操作：

1. **去重**：识别语义相同但措辞不同的条目，合并为一条
2. **精简**：删除过于细碎、无信息量的条目
3. **格式统一**：确保每条事实独立成句，一行一条
4. **保持scope结构**：保留所有 [scope:subtag] 标记不变
5. **不要新增内容**：只能删减和合并，不能添加新信息

特别注意：
- "正在进行某项目"类的条目，如果看起来可能已过时（数周前的事），标记为 [可能过时]
- 同一个观点在多个 scope 出现的，只保留最合适的那个 scope

输出格式与输入相同：[scope] 开头，每个 scope 一段。`;

async function callCleanupLLM(content: string): Promise<string> {
  // Build endpoint URL (same logic as moments-common callOpenAICompatibleAPI)
  let endpoint: string;
  if (llmConn.baseUrl.match(/\/v\d+$/)) {
    endpoint = `${llmConn.baseUrl}/chat/completions`;
  } else {
    endpoint = `${llmConn.baseUrl}/v1/chat/completions`;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llmConn.apiKey) {
    headers.Authorization = `Bearer ${llmConn.apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: llmConn.model,
      messages: [
        { role: 'system', content: CLEANUP_PROMPT },
        { role: 'user', content },
      ],
      temperature: 0.3,
      max_tokens: 10000,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

function getAutoTxtPath(groupId: string, userId: string): string {
  const dirName = userId === '_global_memory_' ? '_global_' : userId;
  return join(MEMORY_DIR, groupId, dirName, 'auto.txt');
}

function getPreviewPath(groupId: string, userId: string): string {
  const dirName = userId === '_global_memory_' ? '_global_' : userId;
  return join(PREVIEW_DIR, groupId, dirName, 'auto.txt');
}

function listUsersInGroup(groupId: string): string[] {
  const groupDir = join(MEMORY_DIR, groupId);
  if (!existsSync(groupDir)) return [];
  return readdirSync(groupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => (e.name === '_global_' ? '_global_memory_' : e.name));
}

async function previewOne(groupId: string, userId: string): Promise<void> {
  const autoPath = getAutoTxtPath(groupId, userId);
  if (!existsSync(autoPath)) {
    console.log(`  SKIP (no auto.txt): ${autoPath}`);
    return;
  }

  const content = readFileSync(autoPath, 'utf-8').trim();
  if (!content) {
    console.log(`  SKIP (empty): ${autoPath}`);
    return;
  }

  console.log(`  Processing: ${autoPath} (${content.length} chars)...`);
  const cleaned = await callCleanupLLM(content);

  const previewPath = getPreviewPath(groupId, userId);
  mkdirSync(join(previewPath, '..'), { recursive: true });
  writeFileSync(previewPath, cleaned, 'utf-8');

  const reduction = content.length > 0 ? ((1 - cleaned.length / content.length) * 100).toFixed(1) : '0';
  console.log(`  → ${previewPath} (${cleaned.length} chars, ${reduction}% reduction)`);
}

function applyOne(groupId: string, userId: string): void {
  const previewPath = getPreviewPath(groupId, userId);
  if (!existsSync(previewPath)) {
    console.log(`  SKIP (no preview): ${previewPath}`);
    return;
  }

  const cleaned = readFileSync(previewPath, 'utf-8');
  const autoPath = getAutoTxtPath(groupId, userId);
  writeFileSync(autoPath, cleaned, 'utf-8');
  console.log(`  Applied: ${previewPath} → ${autoPath}`);
}

async function main() {
  const [, , command, groupId, userId] = process.argv;

  if (!command || !groupId) {
    console.log('Usage:');
    console.log('  bun scripts/migration/cleanup-memory-with-llm.ts preview <groupId> [userId]');
    console.log('  bun scripts/migration/cleanup-memory-with-llm.ts preview-all <groupId>');
    console.log('  bun scripts/migration/cleanup-memory-with-llm.ts apply <groupId> [userId]');
    process.exit(1);
  }

  switch (command) {
    case 'preview': {
      const target = userId || '_global_memory_';
      await previewOne(groupId, target);
      break;
    }
    case 'preview-all': {
      const users = listUsersInGroup(groupId);
      console.log(`Found ${users.length} user(s) in group ${groupId}`);
      for (const uid of users) {
        await previewOne(groupId, uid);
      }
      break;
    }
    case 'apply': {
      if (userId) {
        applyOne(groupId, userId);
      } else {
        const users = listUsersInGroup(groupId);
        for (const uid of users) {
          applyOne(groupId, uid);
        }
      }
      break;
    }
    default:
      console.error('Unknown command:', command);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
