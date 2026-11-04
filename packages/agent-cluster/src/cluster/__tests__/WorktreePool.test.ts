import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git';
import { WorktreePool } from '../workspace/WorktreePool';
import { createSandbox, openClusterDb, PROJECT, type Sandbox } from './worktreeFixtures';

describe('WorktreePool', () => {
  let box: Sandbox;
  let db: Database;
  let pool: WorktreePool;

  async function setUp(overrides: Parameters<typeof createSandbox>[0] = {}): Promise<void> {
    box?.cleanup();
    box = await createSandbox(overrides);
    db = openClusterDb();
    pool = new WorktreePool(box.config, db, box.registry);
  }

  function leaseOrThrow(kind: 'executor' | 'planner', taskId: string) {
    const lease = pool.lease(box.entry, kind, taskId);
    if (!lease) throw new Error(`no ${kind} slot for ${taskId}`);
    return lease;
  }

  beforeEach(() => setUp());
  afterEach(() => {
    db.close();
    box.cleanup();
  });

  test('the default size is the project concurrency, and `worktrees` overrides it', async () => {
    expect(pool.capacity(box.entry)).toEqual({ executor: 2, planner: 1 });
    await setUp({ worktrees: 3 });
    expect(pool.capacity(box.entry)).toEqual({ executor: 3, planner: 1 });
  });

  test('a project that is not a git repository, or sets worktrees to 0, has no pool', async () => {
    await setUp({ worktrees: 0 });
    expect(pool.isPooled(box.entry)).toBe(false);
    await setUp();
    rmSync(join(box.repo, '.git'), { recursive: true });
    expect(pool.isPooled(box.entry)).toBe(false);
  });

  test('slots are leased until none is free, and a returned slot is reused', async () => {
    const first = leaseOrThrow('executor', 'task-1');
    const second = leaseOrThrow('executor', 'task-2');
    expect(first.path).toBe(join(box.stateDir, 'work', PROJECT, '1'));
    expect(second.path).toBe(join(box.stateDir, 'work', PROJECT, '2'));
    expect(pool.lease(box.entry, 'executor', 'task-3')).toBeNull();

    await pool.release(first);
    expect(leaseOrThrow('executor', 'task-3').path).toBe(first.path);
  });

  test('a planner slot does not use up an executor slot', () => {
    expect(leaseOrThrow('planner', 'planner-task').slot).toBe('planner-1');
    leaseOrThrow('executor', 'task-1');
    leaseOrThrow('executor', 'task-2');
    expect(pool.lease(box.entry, 'planner', 'second-planner')).toBeNull();
  });

  test('a lease survives a restart and stays taken until returned', async () => {
    const lease = leaseOrThrow('executor', 'task-1');

    const restarted = new WorktreePool(box.config, db, box.registry);
    expect(restarted.leaseOf('task-1')).toEqual(lease);
    expect(restarted.lease(box.entry, 'executor', 'task-2')?.slot).toBe('2');
    expect(restarted.lease(box.entry, 'executor', 'task-3')).toBeNull();

    await restarted.release(lease);
    expect(restarted.leaseOf('task-1')).toBeNull();
    expect(restarted.lease(box.entry, 'executor', 'task-3')?.slot).toBe('1');
  });

  test('prepare checks the branch out from the start point and release frees it again', async () => {
    const lease = leaseOrThrow('executor', 'task-1');
    await git(box.repo, ['branch', 'cluster/job']);
    await pool.prepare(lease, box.entry, 'cluster/job-task', 'cluster/job');
    expect(await git(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('cluster/job-task');

    writeFileSync(join(lease.path, 'README.md'), 'edited\n');
    writeFileSync(join(lease.path, 'stray.txt'), 'untracked\n');
    expect((await pool.uncommitted(lease)).sort()).toEqual([' M README.md', '?? stray.txt']);

    await pool.release(lease);
    expect(await git(lease.path, ['status', '--porcelain'])).toBe('');
    expect(await git(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    // The branch is free for a new checkout elsewhere.
    await git(box.repo, ['worktree', 'add', '-q', join(box.stateDir, 'elsewhere'), 'cluster/job-task']);
  });

  test('installs only when the lockfile differs from the one last installed, and keeps node_modules', async () => {
    await setUp({ install: 'echo run >> ../install-count; mkdir -p node_modules; echo kept > node_modules/marker' });
    writeFileSync(join(box.repo, 'bun.lock'), 'v1\n');
    await git(box.repo, ['add', 'bun.lock']);
    await git(box.repo, ['commit', '-qm', 'lock v1']);
    const count = join(box.stateDir, 'work', PROJECT, 'install-count');
    const runs = () => readFileSync(count, 'utf8').trim().split('\n').length;

    const first = leaseOrThrow('executor', 'task-1');
    await pool.prepare(first, box.entry, 'b1', 'master');
    expect(runs()).toBe(1);
    await pool.release(first);

    const second = leaseOrThrow('executor', 'task-2');
    await pool.prepare(second, box.entry, 'b2', 'master');
    expect(runs()).toBe(1);
    expect(existsSync(join(second.path, 'node_modules', 'marker'))).toBe(true);
    await pool.release(second);

    writeFileSync(join(box.repo, 'bun.lock'), 'v2\n');
    await git(box.repo, ['commit', '-qam', 'lock v2']);
    const third = leaseOrThrow('executor', 'task-3');
    await pool.prepare(third, box.entry, 'b3', 'master');
    expect(runs()).toBe(2);
  });

  test('a failed install fails prepare and runs again on the next lease', async () => {
    await setUp({ install: 'echo run >> ../install-count; exit 3' });
    const lease = leaseOrThrow('executor', 'task-1');
    await expect(pool.prepare(lease, box.entry, 'b1', 'master')).rejects.toThrow('exited with 3');
    await pool.release(lease);

    const again = leaseOrThrow('executor', 'task-2');
    await expect(pool.prepare(again, box.entry, 'b2', 'master')).rejects.toThrow('exited with 3');
    expect(readFileSync(join(box.stateDir, 'work', PROJECT, 'install-count'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('planner slots never install', async () => {
    await setUp({ install: 'touch ../installed' });
    const lease = leaseOrThrow('planner', 'planner-task');
    await pool.prepare(lease, box.entry, 'plan', 'master');
    expect(existsSync(join(box.stateDir, 'work', PROJECT, 'installed'))).toBe(false);
  });

  test('a slot that lost its .git never reaches the checkout it sits inside', async () => {
    const before = await git(box.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    writeFileSync(join(box.repo, 'README.md'), 'owner is editing this\n');

    const lease = leaseOrThrow('executor', 'task-1');
    await pool.prepare(lease, box.entry, 'b1', 'master');
    rmSync(join(lease.path, '.git'));
    await pool.release(lease);

    expect(readFileSync(join(box.repo, 'README.md'), 'utf8')).toBe('owner is editing this\n');
    expect(await git(box.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(before);

    const rebuilt = leaseOrThrow('executor', 'task-2');
    await pool.prepare(rebuilt, box.entry, 'b2', 'master');
    expect(await git(rebuilt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('b2');
    expect(readFileSync(join(box.repo, 'README.md'), 'utf8')).toBe('owner is editing this\n');
  });

  test('gc removes what no pool entry claims and keeps slots and leases', async () => {
    const kept = leaseOrThrow('executor', 'task-1');
    await pool.prepare(kept, box.entry, 'b1', 'master');
    const idle = leaseOrThrow('executor', 'task-2');
    await pool.prepare(idle, box.entry, 'b2', 'master');
    await pool.release(idle);

    const beyondPool = join(box.stateDir, 'work', PROJECT, '9');
    await git(box.repo, ['worktree', 'add', '-q', '--detach', beyondPool]);
    const unknownProject = join(box.stateDir, 'work', 'gone', '1');
    mkdirSync(unknownProject, { recursive: true });

    expect((await pool.gc({ dryRun: true })).sort()).toEqual([beyondPool, unknownProject].sort());
    expect(existsSync(beyondPool)).toBe(true);

    expect((await pool.gc()).sort()).toEqual([beyondPool, unknownProject].sort());
    expect(existsSync(beyondPool)).toBe(false);
    expect(existsSync(join(box.stateDir, 'work', 'gone'))).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(idle.path)).toBe(true);
    expect(await git(box.repo, ['worktree', 'list'])).not.toContain(`${PROJECT}/9`);
  });

  test('gc keeps a leased slot even beyond the configured size', async () => {
    const lease = leaseOrThrow('executor', 'task-1');
    await pool.prepare(lease, box.entry, 'b1', 'master');
    box.entry.worktrees = 0;
    expect(await pool.gc()).toEqual([]);
    expect(existsSync(lease.path)).toBe(true);
  });

  test('status reports the pool size and what is leased', () => {
    const lease = leaseOrThrow('executor', 'task-1');
    expect(pool.status()).toEqual([
      {
        project: PROJECT,
        size: 2,
        plannerSize: 1,
        leased: [{ slot: '1', kind: 'executor', path: lease.path, taskId: 'task-1', leasedAt: lease.leasedAt }],
      },
    ]);
  });
});
