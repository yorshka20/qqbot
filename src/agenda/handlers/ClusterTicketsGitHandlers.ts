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

/** Hourly `git pull` in tickets dir. */
export class ClusterTicketsPullHandler implements ActionHandler {
  readonly name = 'cluster_tickets_pull';

  async execute(_ctx: ActionHandlerContext): Promise<string | undefined> {
    const dir = getTicketsDir();
    if (!isGitRepo(dir)) {
      const msg = `${TAG} cluster_tickets_pull: not a git repository: ${dir}`;
      logger.error(msg);
      return `❌ ${msg}`;
    }

    const { code, stdout, stderr } = await runGit(dir, ['pull', '--ff-only']);
    const out = `${stdout}${stderr}`.trim();

    if (code !== 0) {
      const msg = `${TAG} git pull failed (exit ${code}): ${out || stderr}`;
      logger.error(msg);
      return `❌ cluster_tickets_pull: ${out || stderr}`;
    }

    if (out) {
      logger.info(`${TAG} git pull: ${out}`);
    } else {
      logger.debug(`${TAG} git pull: ok (no output)`);
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

    const status = await runGit(dir, ['status', '--porcelain']);
    if (status.code !== 0) {
      return `❌ cluster_tickets_commit_push: git status failed: ${status.stderr}`;
    }

    if (!status.stdout.trim()) {
      logger.debug(`${TAG} working tree clean, skip commit/push`);
      return;
    }

    const add = await runGit(dir, ['add', '-A']);
    if (add.code !== 0) {
      return `❌ cluster_tickets_commit_push: git add failed: ${add.stderr}`;
    }

    const msg = `[bot] auto-sync tickets ${new Date().toISOString()}`;
    const commit = await runGit(dir, ['commit', '-m', msg]);
    if (commit.code !== 0) {
      return `❌ cluster_tickets_commit_push: git commit failed: ${commit.stderr || commit.stdout}`;
    }

    const push = await runGit(dir, ['push']);
    if (push.code !== 0) {
      return `❌ cluster_tickets_commit_push: git push failed: ${push.stderr || push.stdout}`;
    }

    logger.info(`${TAG} committed and pushed: ${msg}`);
  }
}
