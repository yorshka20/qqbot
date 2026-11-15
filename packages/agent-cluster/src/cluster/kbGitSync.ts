/**
 * Two-way git sync of the knowledge-base repository a project checkout reaches through its `_kb`
 * link. The kb holds one folder per project and is written from several machines at once.
 */

import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';

import { runGit } from './git';
import { type CheckpointCommit, syncGitRepo } from './gitRepoSync';

export const KNOWLEDGE_BASE_LINK = '_kb';

/**
 * Every session prepends a line to the same `index.md` files, so concurrent sessions conflict there
 * on almost every sync while touching nothing else in common. The lines are independent entries:
 * git's built-in union driver keeps both sides' lines instead of stopping.
 */
export const KB_MERGE_ATTRIBUTES = ['index.md merge=union'];

/** The kb's commit convention: never mix two projects in one commit; root files belong to `kb`. */
const ROOT_SCOPE = 'kb';

export type KbSyncResult =
  | { ok: true; root: string; committed: number; pulled: number; pushed: number }
  | { ok: false; error: string; conflicts?: string[] };

/** The repository root behind a `_kb` link, or behind any path inside the kb. */
export async function resolveKnowledgeBaseRoot(path: string): Promise<string | undefined> {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return undefined;
  }
  const top = await runGit(real, ['rev-parse', '--show-toplevel']);
  return top.code === 0 ? top.stdout.trim() : undefined;
}

/** One checkpoint commit per top-level folder (project, `_shared`), plus one for root files. */
export function kbCheckpointCommits(paths: string[], machine: string): CheckpointCommit[] {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const slash = path.indexOf('/');
    const scope = slash > 0 ? path.slice(0, slash) : ROOT_SCOPE;
    const pathspec = slash > 0 ? scope : path;
    const group = groups.get(scope) ?? new Set<string>();
    group.add(pathspec);
    groups.set(scope, group);
  }
  return [...groups.keys()].sort().map((scope) => ({
    message: `${scope}: sync: checkpoint from ${machine}`,
    pathspecs: [...(groups.get(scope) ?? [])].sort(),
  }));
}

export async function syncKnowledgeBase(path: string): Promise<KbSyncResult> {
  const root = await resolveKnowledgeBaseRoot(path);
  if (!root) {
    return { ok: false, error: `no knowledge-base git repository at ${path}` };
  }
  const machine = hostname();
  const result = await syncGitRepo(root, {
    checkpoint: (changed) => kbCheckpointCommits(changed, machine),
    mergeAttributes: KB_MERGE_ATTRIBUTES,
  });
  return result.ok ? { ...result, root } : result;
}
