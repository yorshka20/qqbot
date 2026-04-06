#!/usr/bin/env bun
/**
 * Initialize memory_fact_meta table from existing auto.txt files.
 *
 * Traverses all auto.txt files, parses [scope] sections → splits into facts → computes hash.
 * Inserts metadata for each fact (idempotent: INSERT OR IGNORE).
 *
 * Usage:
 *   bun scripts/migration/init-memory-fact-meta.ts [path/to/bot.db]
 *
 * Default DB path: data/bot.db
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_PATH = process.argv[2] || 'data/bot.db';
const MEMORY_DIR = process.env.MEMORY_DIR || 'data/memory';

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s。！？；.!?;，,、：:""''（）()[\]【】]+/g, ' ')
    .trim();
}

function computeFactHash(groupId: string, userId: string, scope: string, content: string): string {
  const normalized = normalizeContent(content);
  const input = `${groupId}:${userId}:${scope}:${normalized}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

interface ParsedSection {
  scope: string;
  content: string;
}

function parseMemorySections(text: string): ParsedSection[] {
  if (!text.trim()) return [];
  const sections: ParsedSection[] = [];
  const regex = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\[|\s*$)/g;
  for (const match of text.matchAll(regex)) {
    const scope = match[1].trim().toLowerCase();
    const content = match[2].trim();
    if (content) sections.push({ scope, content });
  }
  return sections;
}

function splitIntoFacts(content: string): string[] {
  return content
    .split(/(?<=[。！？；.!?;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error('Database file not found:', DB_PATH);
    process.exit(1);
  }
  if (!existsSync(MEMORY_DIR)) {
    console.error('Memory directory not found:', MEMORY_DIR);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Ensure table exists
  db.run(`CREATE TABLE IF NOT EXISTS memory_fact_meta (
    id TEXT PRIMARY KEY,
    factHash TEXT NOT NULL UNIQUE,
    groupId TEXT NOT NULL,
    userId TEXT NOT NULL,
    scope TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual', 'llm_extract')),
    firstSeen INTEGER NOT NULL,
    lastReinforced INTEGER NOT NULL,
    reinforceCount INTEGER NOT NULL DEFAULT 1,
    hitCount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale')),
    staleSince INTEGER,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO memory_fact_meta
      (id, factHash, groupId, userId, scope, source, firstSeen, lastReinforced, reinforceCount, hitCount, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'active', ?, ?)
  `);

  const groups = readdirSync(MEMORY_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let totalFacts = 0;
  let insertedFacts = 0;

  for (const groupId of groups) {
    const groupDir = join(MEMORY_DIR, groupId);
    const entries = readdirSync(groupDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const userId = entry.name === '_global_' ? '_global_memory_' : entry.name;

      // Process both layers
      for (const layer of ['auto', 'manual'] as const) {
        const filePath = join(groupDir, entry.name, `${layer}.txt`);
        if (!existsSync(filePath)) continue;

        const text = readFileSync(filePath, 'utf-8');
        const sections = parseMemorySections(text);
        const source = layer === 'manual' ? 'manual' : 'llm_extract';
        const now = Date.now();
        const nowIso = new Date().toISOString();

        for (const section of sections) {
          const facts = splitIntoFacts(section.content);
          for (const fact of facts) {
            const hash = computeFactHash(groupId, userId, section.scope, fact);
            totalFacts++;
            try {
              const result = insertStmt.run(
                crypto.randomUUID(),
                hash,
                groupId,
                userId,
                section.scope,
                source,
                now,
                now,
                nowIso,
                nowIso,
              );
              if ((result as { changes: number }).changes > 0) {
                insertedFacts++;
              }
            } catch (err) {
              console.warn(`  WARN: Failed to insert fact for ${groupId}/${userId}/${section.scope}:`, err);
            }
          }
        }
      }
    }
  }

  db.close();
  console.log(`Done. Total facts scanned: ${totalFacts}, Newly inserted: ${insertedFacts}`);
}

main();
