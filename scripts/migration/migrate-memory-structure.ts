#!/usr/bin/env bun
/**
 * Memory Structure Migration: single-file → dual-layer directory structure
 *
 * Migrates existing data/memory/{groupId}/{userId}.txt and _global_.txt
 * to data/memory/{groupId}/{userId}/auto.txt and _global_/auto.txt
 * Also creates empty manual.txt files.
 *
 * Usage:
 *   bun scripts/migration/migrate-memory-structure.ts --dry-run   # Preview
 *   bun scripts/migration/migrate-memory-structure.ts              # Execute
 */

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_DIR = process.env.MEMORY_DIR || 'data/memory';
const DRY_RUN = process.argv.includes('--dry-run');

function migrate() {
  if (!existsSync(MEMORY_DIR)) {
    console.log('Memory directory does not exist:', MEMORY_DIR);
    return;
  }

  const groups = readdirSync(MEMORY_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let movedCount = 0;
  let skippedCount = 0;

  for (const groupId of groups) {
    const groupDir = join(MEMORY_DIR, groupId);
    const entries = readdirSync(groupDir, { withFileTypes: true });

    for (const entry of entries) {
      // Only process .txt files (old format)
      if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;

      const oldPath = join(groupDir, entry.name);
      const isGlobal = entry.name === '_global_.txt';
      const dirName = isGlobal ? '_global_' : entry.name.replace('.txt', '');
      const newDir = join(groupDir, dirName);
      const newAutoPath = join(newDir, 'auto.txt');
      const newManualPath = join(newDir, 'manual.txt');

      // Check if already migrated
      if (existsSync(newDir) && existsSync(newAutoPath)) {
        console.log(`  SKIP (already migrated): ${oldPath}`);
        skippedCount++;
        continue;
      }

      console.log(`  MOVE: ${oldPath} → ${newAutoPath}`);
      console.log(`  CREATE: ${newManualPath} (empty)`);

      if (!DRY_RUN) {
        mkdirSync(newDir, { recursive: true });
        renameSync(oldPath, newAutoPath);
        writeFileSync(newManualPath, '', 'utf-8');
      }
      movedCount++;
    }
  }

  console.log(`\nDone. Moved: ${movedCount}, Skipped: ${skippedCount}`);
  if (DRY_RUN) console.log('(dry run - no changes made)');
}

migrate();
