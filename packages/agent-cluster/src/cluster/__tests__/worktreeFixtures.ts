import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry, ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import { type ClusterConfig, parseClusterConfig } from '../config';
import { git } from '../git';
import { createClusterTables } from '../schema';

export const PROJECT = 'proj';
export const EXECUTOR = 'fake-executor';
export const PLANNER = 'fake-planner';

/** The columns `ClusterManager` adds by migration, on top of `createClusterTables`. */
export function openClusterDb(path = ':memory:'): Database {
  const db = new Database(path, { create: true });
  createClusterTables(db);
  for (const column of [
    'workerPid INTEGER',
    'workerStartedAt TEXT',
    'logPath TEXT',
    'sessionId TEXT',
    'acknowledgedAt TEXT',
    'model TEXT',
    'usage TEXT',
    'branch TEXT',
    'worktreePath TEXT',
    'mergedAt TEXT',
  ]) {
    db.run(`ALTER TABLE cluster_tasks ADD COLUMN ${column}`);
  }
  db.run('ALTER TABLE cluster_jobs ADD COLUMN integrationBranch TEXT');
  return db;
}

export interface Sandbox {
  repo: string;
  stateDir: string;
  config: ClusterConfig;
  entry: ProjectEntry;
  registry: ProjectRegistry;
  cleanup(): void;
}

/** A real repository with one commit on `master`, a state directory, and a registry that knows them. */
export async function createSandbox(overrides: Partial<ProjectEntry> = {}): Promise<Sandbox> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-pool-')));
  const repo = join(root, 'repo');
  await Bun.$`git init -q -b master ${repo}`;
  await git(repo, ['config', 'user.email', 'worker@example.invalid']);
  await git(repo, ['config', 'user.name', 'worker']);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'initial']);

  // Inside the checkout, as the default `data/cluster` is.
  const stateDir = join(repo, 'state');
  await Bun.$`echo state/ >> ${join(repo, '.git/info/exclude')}`;

  const config = parseClusterConfig({
    enabled: true,
    stateDir,
    schedulingInterval: 60_000,
    maxConcurrentWorkers: 6,
    workerTemplates: {
      [EXECUTOR]: { type: 'claude-cli', command: 'sh', args: [], maxConcurrent: 4 },
      [PLANNER]: { type: 'claude-cli', role: 'planner', command: 'sh', args: [], maxConcurrent: 1 },
    },
    projects: { [PROJECT]: { maxWorkers: 2, workerPreference: EXECUTOR } },
  });
  if (!config) throw new Error('parseClusterConfig returned null');

  const entry: ProjectEntry = { alias: PROJECT, path: repo, type: 'generic', hasClaudeMd: false, ...overrides };
  const registry = {
    resolve: (alias?: string) => (alias === PROJECT ? entry : null),
    list: () => [entry],
  } as unknown as ProjectRegistry;

  return { repo, stateDir, config, entry, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(cwd, file), content);
  await git(cwd, ['add', file]);
  await git(cwd, ['commit', '-qm', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

export async function waitFor(condition: () => boolean, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${label} not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
