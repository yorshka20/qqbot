/**
 * Shared git workflow for the cluster-tickets repo: commit if dirty → pull --rebase → push.
 * Used by the agenda action `cluster_tickets_sync`, `/cluster-sync`, and the `cluster-tickets-sync` CLI.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { logger } from '@/utils/logger';

/** Default ProjectRegistry alias for the centralized tickets repo */
export const CLUSTER_TICKETS_REGISTRY_ALIAS = 'cluster-tickets';

export type ClusterTicketsRegistrySyncResult =
  | { ok: true; path: string; alias: string }
  | { ok: false; message: string };

/**
 * Resolve a registry alias to a path and run {@link syncClusterTicketsGitRepo}.
 * Single entry point for agenda action, `/cluster-sync`, and CLI.
 */
export async function runClusterTicketsSyncWithRegistry(
  registry: ProjectRegistry,
  alias?: string,
): Promise<ClusterTicketsRegistrySyncResult> {
  const a = alias?.trim() || CLUSTER_TICKETS_REGISTRY_ALIAS;
  const entry = registry.resolve(a);
  if (!entry) {
    const listed = registry
      .list()
      .map((p) => p.alias)
      .join(', ');
    return {
      ok: false,
      message: `❌ ProjectRegistry 中没有别名 "${a}"。` + (listed ? `已注册: ${listed}` : '当前无任何注册项目。'),
    };
  }
  const err = await syncClusterTicketsGitRepo(entry.path);
  if (err) {
    return { ok: false, message: err };
  }
  return { ok: true, path: entry.path, alias: entry.alias };
}

const TAG = '[ClusterTicketsGit]';

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

export function isClusterTicketsGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function combineOut(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}${r.stderr}`.trim();
}

/**
 * Stages all changes (including untracked) and commits if the working tree is dirty.
 */
async function commitAllIfDirty(
  dir: string,
  message: string,
): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
  const status = await runGit(dir, ['status', '--porcelain']);
  if (status.code !== 0) {
    return { ok: false, error: `git status failed: ${status.stderr}` };
  }
  if (!status.stdout.trim()) {
    return { ok: true, committed: false };
  }

  const add = await runGit(dir, ['add', '-A']);
  if (add.code !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr}` };
  }

  const commit = await runGit(dir, ['commit', '-m', message]);
  if (commit.code !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }

  return { ok: true, committed: true };
}

/** Best-effort: leave repo out of a half-finished rebase/merge after a failed pull. */
async function abortIntegrationIfNeeded(dir: string): Promise<void> {
  const rebase = await runGit(dir, ['rebase', '--abort']);
  if (rebase.code === 0) {
    logger.warn(`${TAG} aborted in-progress rebase after failed pull`);
  }
  const merge = await runGit(dir, ['merge', '--abort']);
  if (merge.code === 0) {
    logger.warn(`${TAG} aborted in-progress merge after failed pull`);
  }
}

/**
 * One-shot sync: checkpoint local WIP → pull --rebase → push.
 * @returns `undefined` on success, error message on failure (matches ActionHandler contract).
 */
export async function syncClusterTicketsGitRepo(dir: string): Promise<string | undefined> {
  if (!isClusterTicketsGitRepo(dir)) {
    const msg = `${TAG} cluster_tickets_sync: not a git repository: ${dir}`;
    logger.error(msg);
    return `❌ ${msg}`;
  }

  const ts = new Date().toISOString();
  const checkpointMsg = `[bot] sync tickets ${ts}`;

  const checkpoint = await commitAllIfDirty(dir, checkpointMsg);
  if (!checkpoint.ok) {
    const err = `❌ cluster_tickets_sync: ${checkpoint.error}`;
    logger.error(`${TAG} ${checkpoint.error}`);
    return err;
  }
  if (checkpoint.committed) {
    logger.info(`${TAG} committed local changes: ${checkpointMsg}`);
  }

  const pull = await runGit(dir, ['pull', '--rebase']);
  const pullOut = combineOut(pull);

  if (pull.code !== 0) {
    await abortIntegrationIfNeeded(dir);
    const msg = `${TAG} git pull --rebase failed (exit ${pull.code}), integration aborted: ${pullOut || pull.stderr}`;
    logger.error(msg);
    return `❌ cluster_tickets_sync: rebase/merge could not complete; repo left consistent (rebase/merge aborted if needed). Output:\n${pullOut || pull.stderr}`;
  }

  if (pullOut) {
    logger.info(`${TAG} git pull --rebase: ${pullOut}`);
  }

  const push = await runGit(dir, ['push']);
  const pushOut = combineOut(push);
  if (push.code !== 0) {
    return `❌ cluster_tickets_sync: git push failed: ${push.stderr || push.stdout}`;
  }

  if (pushOut) {
    logger.info(`${TAG} git push: ${pushOut}`);
  }
  logger.info(`${TAG} cluster_tickets_sync complete`);
  return undefined;
}
