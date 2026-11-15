/**
 * Two-way sync of a docs repository that agents edit in place: fetch → commit local changes →
 * rebase onto the upstream branch → push. No LLM is involved; a conflict git cannot resolve aborts
 * the rebase, so the checkout is never left half-integrated.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runGit } from './git';

export interface CheckpointCommit {
  message: string;
  /** Literal pathspecs relative to the repository root. */
  pathspecs: string[];
}

export interface GitRepoSyncOptions {
  /** Splits the changed paths (as `git status --porcelain` names them) into the commits that record them. */
  checkpoint(changedPaths: string[]): CheckpointCommit[];
  /** gitattributes lines in force while the rebase runs, e.g. `index.md merge=union`. */
  mergeAttributes?: string[];
}

export type GitRepoSyncResult =
  | { ok: true; committed: number; pulled: number; pushed: number }
  | { ok: false; error: string; conflicts?: string[] };

export async function syncGitRepo(dir: string, options: GitRepoSyncOptions): Promise<GitRepoSyncResult> {
  const blocker = await integrationInProgress(dir);
  if (blocker) {
    return { ok: false, error: blocker };
  }

  const upstream = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.code !== 0) {
    return { ok: false, error: `current branch has no upstream: ${output(upstream)}` };
  }

  // Fetch before committing: the checkout is edited live, and the rebase refuses a dirty tree, so the
  // network round trip must not sit between the checkpoint commits and the rebase.
  const fetch = await runGit(dir, ['fetch', '--quiet']);
  if (fetch.code !== 0) {
    return { ok: false, error: `git fetch failed: ${output(fetch)}` };
  }

  const changed = await changedPaths(dir);
  if (!changed.ok) {
    return changed;
  }
  const commits = changed.paths.length > 0 ? options.checkpoint(changed.paths) : [];
  for (const commit of commits) {
    const add = await runGit(dir, ['--literal-pathspecs', 'add', '-A', '--', ...commit.pathspecs]);
    if (add.code !== 0) {
      return { ok: false, error: `git add failed: ${output(add)}` };
    }
    const made = await runGit(dir, [
      '--literal-pathspecs',
      'commit',
      '--quiet',
      '-m',
      commit.message,
      '--',
      ...commit.pathspecs,
    ]);
    if (made.code !== 0) {
      return { ok: false, error: `git commit "${commit.message}" failed: ${output(made)}` };
    }
  }

  const pulled = await countCommits(dir, 'HEAD..@{u}');
  if (pulled > 0) {
    const rebased = await rebaseOntoUpstream(dir, options.mergeAttributes ?? []);
    if (!rebased.ok) {
      return rebased;
    }
  }

  const pushed = await countCommits(dir, '@{u}..HEAD');
  if (pushed > 0) {
    const push = await runGit(dir, ['push', '--quiet']);
    if (push.code !== 0) {
      return { ok: false, error: `git push failed: ${output(push)}` };
    }
  }

  return { ok: true, committed: commits.length, pulled, pushed };
}

/**
 * Someone resolving a conflict by hand has a tree full of markers; committing it would publish them.
 */
async function integrationInProgress(dir: string): Promise<string | undefined> {
  for (const [marker, what] of [
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ] as const) {
    const path = await runGit(dir, ['rev-parse', '--git-path', marker]);
    if (path.code !== 0) {
      return `not a git repository: ${dir}`;
    }
    if (existsSync(resolve(dir, path.stdout.trim()))) {
      return `${what} is in progress in ${dir}; finish or abort it first`;
    }
  }
  return undefined;
}

async function changedPaths(dir: string): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const status = await runGit(dir, ['status', '--porcelain=v1', '-z']);
  if (status.code !== 0) {
    return { ok: false, error: `git status failed: ${output(status)}` };
  }
  const fields = status.stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    // A rename or copy is followed by the field naming its source.
    if (entry[0] === 'R' || entry[0] === 'C') {
      paths.push(fields[++i]);
    }
  }
  return { ok: true, paths };
}

async function countCommits(dir: string, range: string): Promise<number> {
  const count = await runGit(dir, ['rev-list', '--count', range]);
  return count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : 0;
}

async function rebaseOntoUpstream(dir: string, mergeAttributes: string[]): Promise<GitRepoSyncResult> {
  // `core.attributesFile` reaches every git process the rebase starts (it travels in
  // GIT_CONFIG_PARAMETERS) and leaves the repository's own configuration untouched.
  let attributesDir: string | undefined;
  const config: string[] = [];
  if (mergeAttributes.length > 0) {
    attributesDir = mkdtempSync(join(tmpdir(), 'git-sync-attributes-'));
    const attributesFile = join(attributesDir, 'attributes');
    writeFileSync(attributesFile, `${mergeAttributes.join('\n')}\n`);
    config.push('-c', `core.attributesFile=${attributesFile}`);
  }
  try {
    const rebase = await runGit(dir, [...config, 'rebase', '--quiet', '@{u}']);
    if (rebase.code === 0) {
      return { ok: true, committed: 0, pulled: 0, pushed: 0 };
    }
    const unmerged = await runGit(dir, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = unmerged.stdout.split('\n').filter(Boolean);
    const abort = await runGit(dir, ['rebase', '--abort']);
    const aborted =
      abort.code === 0 ? 'rebase aborted, local commits kept' : `rebase --abort failed too: ${output(abort)}`;
    return {
      ok: false,
      error: conflicts.length
        ? `rebase hit conflicts git could not resolve (${aborted}): ${conflicts.join(', ')}`
        : `git rebase failed (${aborted}): ${output(rebase)}`,
      conflicts,
    };
  } finally {
    if (attributesDir) {
      rmSync(attributesDir, { recursive: true, force: true });
    }
  }
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stderr}${result.stdout}`.trim();
}
