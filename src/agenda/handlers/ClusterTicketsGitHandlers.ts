// ClusterTicketsGitHandlers — direct git sync for the configured tickets directory (cluster-tickets repo).
// No LLM; schedule: `执行: action cluster_tickets_sync` (commit if dirty → pull --rebase → push).

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
 * Replaces separate pull + commit/push agenda items.
 */
export class ClusterTicketsSyncHandler implements ActionHandler {
  readonly name = 'cluster_tickets_sync';

  async execute(_ctx: ActionHandlerContext): Promise<string | undefined> {
    const dir = getTicketsDir();
    if (!isGitRepo(dir)) {
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
  }
}
