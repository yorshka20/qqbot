import { Database } from 'bun:sqlite';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
  return db;
}

export interface Sandbox {
  repo: string;
  stateDir: string;
  worktreeRoot: string;
  config: ClusterConfig;
  entry: ProjectEntry;
  registry: ProjectRegistry;
  cleanup(): void;
}

// On macOS `git` on the PATH is an xcrun shim that triples the cost of a spawn, and these tests
// spawn hundreds. The binary on git's exec path is the same git on every platform.
const gitExecPath = Bun.spawnSync(['git', '--exec-path']).stdout.toString().trim();
process.env.PATH = `${gitExecPath}${delimiter}${process.env.PATH}`;

/** Process spawns dominate these tests, so the repository every sandbox copies is built once per file. */
let seedRepo: Promise<string> | undefined;

/**
 * For each test file's `afterAll`. Test files share this module within a run, and `bun test` fires
 * no process exit event, so a file has to say when it is done with the seed.
 */
export async function removeSeedRepo(): Promise<void> {
  const repo = await seedRepo;
  seedRepo = undefined;
  if (repo) rmSync(dirname(repo), { recursive: true, force: true });
}

function buildSeedRepo(): Promise<string> {
  seedRepo ??= (async () => {
    const repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'worktree-seed-'))), 'repo');
    await Bun.$`git init -q --template= -b master ${repo}`;
    await git(repo, ['config', 'user.email', 'worker@example.invalid']);
    await git(repo, ['config', 'user.name', 'worker']);
    // Every commit and merge would otherwise spawn a `git maintenance` these short-lived repos never need.
    await git(repo, ['config', 'maintenance.auto', 'false']);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'initial']);
    // Inside the checkout, as the default `data/cluster` is.
    mkdirSync(join(repo, '.git/info'));
    writeFileSync(join(repo, '.git/info/exclude'), 'state/\n');
    return repo;
  })();
  return seedRepo;
}

/** A real repository with one commit on `master`, a state directory, and a registry that knows them. */
export async function createSandbox(overrides: Partial<ProjectEntry> = {}): Promise<Sandbox> {
  const seed = await buildSeedRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-pool-')));
  const repo = join(root, 'repo');
  cpSync(seed, repo, { recursive: true });

  // Inside the checkout, as the default `data/cluster` is and a configured `worktreeRoot` can be.
  const stateDir = join(repo, 'state');
  const worktreeRoot = join(stateDir, 'worktrees');

  const config = parseClusterConfig({
    enabled: true,
    stateDir,
    worktreeRoot,
    schedulingInterval: 60_000,
    workerLivenessInterval: 25,
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

  return {
    repo,
    stateDir,
    worktreeRoot,
    config,
    entry,
    registry,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
