// ClusterTicketsGitHandlers — direct git sync for the configured tickets directory (cluster-tickets repo).
// No LLM; used by schedule items with `执行: action cluster_tickets_pull` / `cluster_tickets_commit_push`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

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

function getTicketsDir(): string {
  const config = getContainer().resolve<Config>(DITokens.CONFIG);
  return config.getTicketsDir();
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function combineOut(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}${r.stderr}`.trim();
}

/**
 * Stages all changes (including untracked) and commits if the working tree is dirty.
 * Used by pull (checkpoint before integrating remote) and by commit_push.
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
 * Pull: checkpoint local WIP (commit if dirty), then integrate remote via rebase.
 * Avoids --ff-only failing when tracked files are modified or untracked paths would be overwritten.
 */
export class ClusterTicketsPullHandler implements ActionHandler {
  readonly name = 'cluster_tickets_pull';

  async execute(_ctx: ActionHandlerContext): Promise<string | undefined> {
    const dir = getTicketsDir();
    if (!isGitRepo(dir)) {
      const msg = `${TAG} cluster_tickets_pull: not a git repository: ${dir}`;
      logger.error(msg);
      return `❌ ${msg}`;
    }

    const checkpointMsg = `[bot] checkpoint before pull ${new Date().toISOString()}`;
    const checkpoint = await commitAllIfDirty(dir, checkpointMsg);
    if (!checkpoint.ok) {
      const err = `❌ cluster_tickets_pull: ${checkpoint.error}`;
      logger.error(`${TAG} ${checkpoint.error}`);
      return err;
    }
    if (checkpoint.committed) {
      logger.info(`${TAG} committed local changes before pull: ${checkpointMsg}`);
    }

    const pull = await runGit(dir, ['pull', '--rebase']);
    const pullOut = combineOut(pull);

    if (pull.code !== 0) {
      await abortIntegrationIfNeeded(dir);
      const msg = `${TAG} git pull --rebase failed (exit ${pull.code}), integration aborted: ${pullOut || pull.stderr}`;
      logger.error(msg);
      return `❌ cluster_tickets_pull: rebase/merge could not complete; repo left consistent (rebase/merge aborted if needed). Output:\n${pullOut || pull.stderr}`;
    }

    if (pullOut) {
      logger.info(`${TAG} git pull --rebase: ${pullOut}`);
    } else {
      logger.debug(`${TAG} git pull --rebase: ok (no output)`);
    }
  }
}

/** Commit + push when the working tree has local changes. */
export class ClusterTicketsCommitPushHandler implements ActionHandler {
  readonly name = 'cluster_tickets_commit_push';

  async execute(_ctx: ActionHandlerContext): Promise<string | undefined> {
    const dir = getTicketsDir();
    if (!isGitRepo(dir)) {
      const msg = `${TAG} cluster_tickets_commit_push: not a git repository: ${dir}`;
      logger.error(msg);
      return `❌ ${msg}`;
    }

    const msg = `[bot] auto-sync tickets ${new Date().toISOString()}`;
    const result = await commitAllIfDirty(dir, msg);
    if (!result.ok) {
      return `❌ cluster_tickets_commit_push: ${result.error}`;
    }
    if (!result.committed) {
      logger.debug(`${TAG} working tree clean, skip commit/push`);
      return;
    }

    const push = await runGit(dir, ['push']);
    if (push.code !== 0) {
      return `❌ cluster_tickets_commit_push: git push failed: ${push.stderr || push.stdout}`;
    }

    logger.info(`${TAG} committed and pushed: ${msg}`);
  }
}
