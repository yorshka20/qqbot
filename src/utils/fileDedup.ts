// File deduplication utility
// Content-based exact deduplication using buffered MD5 hashing.
// Used by DeduplicateFilesTaskExecutor (AI-triggered) and GroupDownloadPlugin (scheduled).

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileReadService, RawFileEntry } from '@/services/file';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeduplicateResult {
  totalFiles: number;
  duplicatesFound: number;
  bytesFreed: number;
  deletedFiles: string[];
  errors: Array<{ file: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute MD5 from a Buffer (buffered; suitable for files ≤~10 MB).
 */
function computeMd5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Dedup algorithm for a single flat directory.
 *
 * 1. Scan directory → collect file entries (via FileReadService.scanDirectory)
 * 2. Group by exact byte size — only same-size files can share content
 * 3. For each size group with 2+ files: read buffer + compute MD5
 * 4. For each MD5 group with 2+ files: keep oldest (min mtime, alpha tiebreak), delete rest
 */
async function deduplicateDir(
  dir: string,
  fileService: FileReadService,
  dryRun: boolean,
  result: DeduplicateResult,
): Promise<void> {
  // Pass 1: collect entries
  const scanResult = fileService.scanDirectory(dir);
  if (!scanResult.success) {
    result.errors.push({ file: dir, error: scanResult.error ?? 'scanDirectory failed' });
    return;
  }

  const entries = scanResult.entries;
  result.totalFiles += entries.length;

  if (entries.length < 2) {
    return;
  }

  // Group by exact size
  const bySize = new Map<number, RawFileEntry[]>();
  for (const entry of entries) {
    const group = bySize.get(entry.size);
    if (group) {
      group.push(entry);
    } else {
      bySize.set(entry.size, [entry]);
    }
  }

  // Only process size groups that could have duplicates
  const candidates = Array.from(bySize.values()).filter((g) => g.length >= 2);
  if (candidates.length === 0) {
    return;
  }

  // Pass 2: compute MD5 for each candidate (buffered read)
  const md5Map = new Map<string, string>(); // path → md5

  for (const entry of candidates.flat()) {
    const readResult = fileService.readFileBinary(entry.path);
    if (!readResult.success || !readResult.data) {
      result.errors.push({
        file: entry.path,
        error: readResult.error ?? 'readFileBinary failed',
      });
      continue; // treat as unique, do not deduplicate
    }
    md5Map.set(entry.path, computeMd5(readResult.data));
  }

  // Pass 3: group by MD5
  const byMd5 = new Map<string, RawFileEntry[]>();
  for (const entry of candidates.flat()) {
    const md5 = md5Map.get(entry.path);
    if (md5 === undefined) continue; // hashing failed

    const group = byMd5.get(md5);
    if (group) {
      group.push(entry);
    } else {
      byMd5.set(md5, [entry]);
    }
  }

  // Pass 4: delete duplicates
  for (const group of byMd5.values()) {
    if (group.length < 2) continue;

    // Keep oldest (min mtime), alphabetical tiebreak
    group.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const toDelete = group.slice(1);

    for (const dup of toDelete) {
      result.duplicatesFound += 1;
      result.bytesFreed += dup.size;

      if (!dryRun) {
        const delResult = fileService.deleteFile(dup.path);
        if (delResult.success) {
          result.deletedFiles.push(dup.path);
          logger.info(`[fileDedup] Deleted duplicate: ${dup.path}`);
        } else {
          result.errors.push({
            file: dup.path,
            error: delResult.error ?? 'deleteFile failed',
          });
        }
      } else {
        result.deletedFiles.push(dup.path);
        logger.debug(`[fileDedup] [DRY RUN] Would delete: ${dup.path}`);
      }
    }
  }
}

/**
 * Run deduplication over one or more flat directories.
 * Each directory is scanned independently; results are aggregated.
 *
 * @param dirs - Absolute or project-root-relative paths to scan
 * @param fileService - FileReadService instance for safe file access
 * @param dryRun - When true, reports duplicates without deleting
 */
export async function runDeduplication(
  dirs: string[],
  fileService: FileReadService,
  dryRun: boolean,
): Promise<DeduplicateResult> {
  const result: DeduplicateResult = {
    totalFiles: 0,
    duplicatesFound: 0,
    bytesFreed: 0,
    deletedFiles: [],
    errors: [],
  };

  for (const dir of dirs) {
    await deduplicateDir(dir, fileService, dryRun, result);
  }

  return result;
}

/**
 * Resolve group directories from a downloads root.
 * Returns absolute paths of all immediate subdirectories of downloadsRoot,
 * or [downloadsRoot/{groupId}] if groupId is specified.
 */
export function resolveGroupDirs(downloadsRoot: string, groupId?: string): string[] {
  if (groupId) {
    return [join(downloadsRoot, groupId.trim())];
  }

  try {
    const entries = readdirSync(downloadsRoot);
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = join(downloadsRoot, entry);
      try {
        if (statSync(full).isDirectory()) {
          dirs.push(full);
        }
      } catch {
        // ignore inaccessible entries
      }
    }
    return dirs;
  } catch {
    return [];
  }
}
