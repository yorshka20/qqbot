// Shared archiver for directories laid out as <root>/YYYY-MM-DD/. Bundles day
// directories older than the retention window into batched archives under an
// archive directory, then optionally removes the originals.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';

export type DateDirArchiveFormat = 'tar.gz' | 'zip';

export interface DateDirArchiveOptions {
  /** Directory holding the YYYY-MM-DD subdirectories. */
  sourceDir: string;
  /** Where archive files are written; nested under sourceDir is fine (non-date names are ignored). */
  archiveDir: string;
  /** Day directories within this many days of today are left untouched. */
  retainDays: number;
  /** How many day directories go into one archive file. */
  batchDays: number;
  format: DateDirArchiveFormat;
  /** Remove a day directory once its archive exists on disk. */
  deleteAfterArchive: boolean;
  /** Prefix for this caller's log lines, e.g. "[LogArchivePlugin]". */
  logLabel: string;
}

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Archive every day directory older than `retainDays`, grouped `batchDays` at a time.
 */
export async function archiveDateDirs(options: DateDirArchiveOptions): Promise<void> {
  const { sourceDir, archiveDir, retainDays, batchDays, format, deleteAfterArchive, logLabel } = options;

  if (!existsSync(sourceDir)) {
    return;
  }
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retainDays);

  const eligible = listDateDirs(sourceDir)
    .filter((d) => d.date < cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (eligible.length === 0) {
    logger.debug(`${logLabel} No directories old enough to archive`);
    return;
  }

  for (let i = 0; i < eligible.length; i += batchDays) {
    const batch = eligible.slice(i, i + batchDays);
    const archiveName = `${formatArchiveName(batch[0].date, batch[batch.length - 1].date)}.${format}`;
    const archivePath = join(archiveDir, archiveName);

    if (existsSync(archivePath)) {
      logger.debug(`${logLabel} Archive already exists: ${archiveName}`);
    } else {
      await createArchive(
        format,
        archivePath,
        sourceDir,
        batch.map((d) => d.dirName),
      );
      logger.info(`${logLabel} Archived ${batch.length} day(s) -> ${archiveName}`);
    }

    if (deleteAfterArchive) {
      for (const dir of batch) {
        removeDir(join(sourceDir, dir.dirName), logLabel);
      }
    }
  }
}

function listDateDirs(sourceDir: string): Array<{ dirName: string; date: Date }> {
  const result: Array<{ dirName: string; date: Date }> = [];
  for (const entry of readdirSync(sourceDir)) {
    if (!DATE_DIR_PATTERN.test(entry)) continue;
    try {
      if (!statSync(join(sourceDir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    const [year, month, day] = entry.split('-').map(Number);
    result.push({ dirName: entry, date: new Date(year, month - 1, day) });
  }
  return result;
}

/** Archive name: YYYY-MMDD-MMDD (start and end day of the batch). */
function formatArchiveName(start: Date, end: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}${pad(start.getDate())}-${pad(end.getMonth() + 1)}${pad(end.getDate())}`;
}

/**
 * Spawn the archiver so compression streams instead of buffering the whole batch
 * in the bot process — a week of dumps runs to hundreds of megabytes.
 *
 * Written to a scratch path and renamed on success: the caller reads "archive file
 * exists" as "this batch is safely stored" before deleting the originals, so a
 * half-written file must never occupy the final name. `zip` also appends to an
 * existing archive rather than replacing it, so any leftover scratch file goes first.
 */
async function createArchive(
  format: DateDirArchiveFormat,
  archivePath: string,
  cwd: string,
  dirNames: string[],
): Promise<void> {
  const partPath = `${archivePath}.part`;
  rmSync(partPath, { force: true });

  const argv =
    format === 'zip' ? ['zip', '-q', '-r', '-X', partPath, ...dirNames] : ['tar', '-czf', partPath, ...dirNames];

  const proc = Bun.spawn(argv, { cwd, stdout: 'ignore', stderr: 'pipe' });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    rmSync(partPath, { force: true });
    throw new Error(`${argv[0]} failed (exit ${exitCode}): ${stderr}`);
  }
  renameSync(partPath, archivePath);
}

function removeDir(fullPath: string, logLabel: string): void {
  try {
    rmSync(fullPath, { recursive: true, force: true });
    logger.debug(`${logLabel} Removed directory: ${fullPath}`);
  } catch (err) {
    logger.warn(`${logLabel} Failed to remove directory ${fullPath}:`, err);
  }
}
