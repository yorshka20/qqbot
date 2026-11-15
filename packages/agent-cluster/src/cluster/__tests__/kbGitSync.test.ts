import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { git } from '../git';
import { kbCheckpointCommits, resolveKnowledgeBaseRoot, syncKnowledgeBase } from '../kbGitSync';

// On macOS `git` on the PATH is an xcrun shim that triples the cost of a spawn.
const gitExecPath = Bun.spawnSync(['git', '--exec-path']).stdout.toString().trim();
process.env.PATH = `${gitExecPath}${delimiter}${process.env.PATH}`;

const INDEX = 'proj/workbook/index.md';
const BASE_INDEX = '# 索引\n\n- [甲 old](old.md) — 旧条目\n';

let seed: string;

beforeAll(async () => {
  seed = join(realpathSync(mkdtempSync(join(tmpdir(), 'kb-sync-seed-'))), 'remote.git');
  await Bun.$`git init -q --bare -b main ${seed}`;
  const work = join(dirname(seed), 'init');
  await Bun.$`git clone -q ${seed} ${work}`.quiet();
  await configure(work);
  mkdirSync(join(work, 'proj/workbook'), { recursive: true });
  writeFileSync(join(work, INDEX), BASE_INDEX);
  writeFileSync(join(work, 'proj/notes.md'), 'one\n');
  writeFileSync(join(work, 'README.md'), 'kb\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-qm', 'initial']);
  await git(work, ['push', '-q', 'origin', 'HEAD:main']);
});

afterAll(() => {
  rmSync(dirname(seed), { recursive: true, force: true });
});

async function configure(repo: string): Promise<void> {
  await git(repo, ['config', 'user.email', 'kb@example.invalid']);
  await git(repo, ['config', 'user.name', 'kb']);
  await git(repo, ['config', 'maintenance.auto', 'false']);
}

/** A remote of its own and two machines that cloned it. */
async function sandbox(): Promise<{ remote: string; a: string; b: string; cleanup(): void }> {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'kb-sync-')));
  const remote = join(box, 'remote.git');
  cpSync(seed, remote, { recursive: true });
  const a = join(box, 'a');
  const b = join(box, 'b');
  for (const clone of [a, b]) {
    await Bun.$`git clone -q ${remote} ${clone}`.quiet();
    await configure(clone);
  }
  return { remote, a, b, cleanup: () => rmSync(box, { recursive: true, force: true }) };
}

describe('kbCheckpointCommits', () => {
  test('one commit per top-level folder, root files under kb', () => {
    expect(kbCheckpointCommits(['proj/a.md', 'README.md', '_shared/scripts/x.py', 'proj/b/c.md', 'newproj/'], 'host')).toEqual([
      { message: '_shared: sync: checkpoint from host', pathspecs: ['_shared'] },
      { message: 'kb: sync: checkpoint from host', pathspecs: ['README.md'] },
      { message: 'newproj: sync: checkpoint from host', pathspecs: ['newproj'] },
      { message: 'proj: sync: checkpoint from host', pathspecs: ['proj'] },
    ]);
  });
});

describe('syncKnowledgeBase', () => {
  test('both machines prepend to the same index: union-merged, committed per project, pushed', async () => {
    const box = await sandbox();
    try {
      writeFileSync(join(box.b, INDEX), BASE_INDEX.replace('- [甲 old]', '- [乙 remote](r.md) — 远端\n- [甲 old]'));
      writeFileSync(join(box.b, 'proj/remote.md'), 'remote\n');
      const fromB = await syncKnowledgeBase(box.b);
      expect(fromB).toMatchObject({ ok: true, committed: 1, pulled: 0, pushed: 1 });

      writeFileSync(join(box.a, INDEX), BASE_INDEX.replace('- [甲 old]', '- [丙 local](l.md) — 本地\n- [甲 old]'));
      mkdirSync(join(box.a, 'other'));
      writeFileSync(join(box.a, 'other/note.md'), 'other\n');
      const fromA = await syncKnowledgeBase(box.a);
      expect(fromA).toMatchObject({ ok: true, committed: 2, pulled: 1, pushed: 2 });

      const index = readFileSync(join(box.a, INDEX), 'utf8');
      expect(index).toContain('- [乙 remote](r.md)');
      expect(index).toContain('- [丙 local](l.md)');
      expect(index).toContain('- [甲 old](old.md)');
      expect(index).not.toContain('<<<<<<<');
      expect(existsSync(join(box.a, 'proj/remote.md'))).toBe(true);
      expect(await git(box.a, ['status', '--porcelain'])).toBe('');
      expect(await git(box.a, ['rev-parse', 'HEAD'])).toBe(await git(box.remote, ['rev-parse', 'main']));
      const subjects = (await git(box.a, ['log', '--format=%s', '-2'])).split('\n').sort();
      expect(subjects[0]).toStartWith('other: sync: checkpoint from ');
      expect(subjects[1]).toStartWith('proj: sync: checkpoint from ');
    } finally {
      box.cleanup();
    }
  });

  test('a real conflict aborts the rebase and keeps the local commit; a hand-resolution in progress is left alone', async () => {
    const box = await sandbox();
    try {
      writeFileSync(join(box.b, 'proj/notes.md'), 'remote edit\n');
      expect((await syncKnowledgeBase(box.b)).ok).toBe(true);

      writeFileSync(join(box.a, 'proj/notes.md'), 'local edit\n');
      const result = await syncKnowledgeBase(box.a);
      expect(result).toMatchObject({ ok: false, conflicts: ['proj/notes.md'] });
      expect(await git(box.a, ['status', '--porcelain'])).toBe('');
      expect(await git(box.a, ['rev-list', '--count', '@{u}..HEAD'])).toBe('1');
      expect(readFileSync(join(box.a, 'proj/notes.md'), 'utf8')).toBe('local edit\n');

      await Bun.$`git -C ${box.a} rebase @{u}`.nothrow().quiet();
      const head = await git(box.a, ['rev-parse', 'HEAD']);
      const blocked = await syncKnowledgeBase(box.a);
      expect(blocked.ok).toBe(false);
      expect(blocked.ok ? '' : blocked.error).toContain('a rebase is in progress');
      expect(await git(box.a, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      box.cleanup();
    }
  });

  test('resolves the repository root through a `_kb` link to a project folder', async () => {
    const box = await sandbox();
    try {
      const link = join(dirname(box.a), '_kb');
      symlinkSync(join(box.a, 'proj'), link);
      expect(await resolveKnowledgeBaseRoot(link)).toBe(box.a);
      expect(await resolveKnowledgeBaseRoot(join(dirname(box.a), 'missing'))).toBeUndefined();
    } finally {
      box.cleanup();
    }
  });
});
