/**
 * Git sync of the cluster-tickets repo through {@link syncGitRepo}.
 * Used by the agenda action `cluster_tickets_sync`, `/cluster-sync`, and the `cluster-tickets-sync` CLI.
 */

import { logger } from '@qqbot/shared';

import type { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import { syncGitRepo } from './gitRepoSync';

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

/**
 * One-shot sync: checkpoint local WIP → rebase onto upstream → push.
 * @returns `undefined` on success, error message on failure (matches ActionHandler contract).
 */
export async function syncClusterTicketsGitRepo(dir: string): Promise<string | undefined> {
  const checkpointMsg = `[bot] sync tickets ${new Date().toISOString()}`;
  const result = await syncGitRepo(dir, {
    checkpoint: () => [{ message: checkpointMsg, pathspecs: ['.'] }],
  });
  if (!result.ok) {
    logger.error(`${TAG} cluster_tickets_sync failed in ${dir}: ${result.error}`);
    return `❌ cluster_tickets_sync: ${result.error}`;
  }
  logger.info(
    `${TAG} cluster_tickets_sync complete: committed ${result.committed}, pulled ${result.pulled}, pushed ${result.pushed}`,
  );
  return undefined;
}
