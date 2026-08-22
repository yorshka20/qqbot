import { describe, expect, it } from 'bun:test';
import { FileReadService } from '@/services/file';
import { ReadOnlyShellService } from '../ReadOnlyShellService';

// Tests run from the repo root, which is also the service's project root —
// spawn-based cases exercise the real git/ls/cat binaries on this repo.
const service = new ReadOnlyShellService(new FileReadService(), process.cwd());

describe('ReadOnlyShellService — binary allowlist', () => {
  it.each(['echo hi', 'node -e 1', 'curl http://x', 'bash -c ls', 'sh -c ls', '/bin/ls'])(
    'rejects non-allowlisted binary: %s',
    (cmd) => {
      const r = service.run(cmd);
      expect(r.success).toBe(false);
      expect(r.error).toContain('不支持的命令');
    },
  );
});

describe('ReadOnlyShellService — no shell syntax', () => {
  it.each([
    'git log | head -5',
    'ls > /tmp/out',
    'git log; ls',
    'git log && ls',
    'cat `whoami`',
    'ls $(pwd)',
    'ls & ls',
  ])('rejects shell operators: %s', (cmd) => {
    const r = service.run(cmd);
    expect(r.success).toBe(false);
    expect(r.error).toContain('不支持 shell 语法');
  });

  it('rejects unclosed quotes', () => {
    const r = service.run('rg "unclosed pattern');
    expect(r.success).toBe(false);
    expect(r.error).toContain('引号未闭合');
  });

  it('allows shell-special characters inside quotes (regex args)', () => {
    const r = service.run('rg "cardSent|endTurn" packages/bot/src/hooks/metadata.ts');
    expect(r.success).toBe(true);
    expect(r.output).toContain('cardSent');
  });
});

describe('ReadOnlyShellService — git policy', () => {
  it.each(['git push', 'git commit -m x', 'git checkout main', 'git config user.name', 'git stash pop'])(
    'rejects non-readonly subcommand: %s',
    (cmd) => {
      const r = service.run(cmd);
      expect(r.success).toBe(false);
      expect(r.error).toContain('只读子命令');
    },
  );

  it('rejects global options before the subcommand (-c pager execution vector)', () => {
    const r = service.run('git -c core.pager=touch log');
    expect(r.success).toBe(false);
    expect(r.error).toContain('只读子命令');
  });

  it('rejects file-writing and pager-executing flags', () => {
    expect(service.run('git log --output=/tmp/x').success).toBe(false);
    expect(service.run('git grep -Oless foo').success).toBe(false);
  });

  it('rejects ref creation via bare positionals on branch/tag', () => {
    expect(service.run('git branch new-branch').error).toContain('会创建引用');
    expect(service.run('git tag v99.99').error).toContain('会创建引用');
    expect(service.run('git branch -D master').error).toContain('仅支持查询');
    expect(service.run('git tag -a v1 -m x').error).toContain('仅支持查询');
  });

  it('allows read-only git usage', () => {
    const log = service.run('git log --oneline -3');
    expect(log.success).toBe(true);
    expect(log.output.split('\n').length).toBeGreaterThanOrEqual(1);

    expect(service.run('git status').success).toBe(true);
    expect(service.run('git branch --list').success).toBe(true);
    expect(service.run('git rev-parse --abbrev-ref HEAD').success).toBe(true);
  });
});

describe('ReadOnlyShellService — path boundary', () => {
  it.each([
    'cat config.d/ai.jsonc',
    'ls config.d',
    'rg key config.d',
    'head -c 100 ./config.d/ai.jsonc',
    'wc -l config.d/ai.jsonc',
  ])('denies secret paths: %s', (cmd) => {
    const r = service.run(cmd);
    expect(r.success).toBe(false);
    expect(r.error).toContain('不可访问的路径');
  });

  it('denies paths outside the project root', () => {
    expect(service.run('cat /etc/hosts').error).toContain('路径超出项目根目录');
    expect(service.run('ls ..').error).toContain('路径超出项目根目录');
  });

  it('denies secret paths embedded in --flag=value', () => {
    const r = service.run('rg foo --iglob=config.d/ai.jsonc');
    expect(r.success).toBe(false);
  });

  it('allows dot-directories for reads (.git inspection)', () => {
    const r = service.run('ls .git');
    expect(r.success).toBe(true);
    expect(r.output).toContain('HEAD');
  });

  it('allows normal repo reads', () => {
    const r = service.run('cat package.json');
    expect(r.success).toBe(true);
    expect(r.output).toContain('"name"');
  });
});

describe('ReadOnlyShellService — search hardening', () => {
  it.each(['rg --no-ignore key', 'rg -uu key', 'rg --pre=sh key', 'rg -f patterns.txt', 'grep -rn --exclude-from=x key .'])(
    'rejects ignore-bypassing / program-executing flags: %s',
    (cmd) => {
      const r = service.run(cmd);
      expect(r.success).toBe(false);
      expect(r.error).toContain('参数不可用');
    },
  );

  it('recursive grep from root cannot surface config.d content', () => {
    // plain grep ignores .gitignore; the forced --exclude-dir must keep secrets out
    const r = service.run('grep -rl apiKey config.d');
    expect(r.success).toBe(false);
  });
});
