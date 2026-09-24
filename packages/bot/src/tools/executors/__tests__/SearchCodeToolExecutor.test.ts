import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileReadService } from '@/services/file';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { SEARCH_CODE_MAX_CHARS, SearchCodeToolExecutor, searchCodeTruncationNotice } from '../SearchCodeToolExecutor';

const context = { userId: 1, messageType: 'private' } as ToolExecutionContext;

function searchCall(parameters: Record<string, unknown>): ToolCall {
  return { type: 'search_code', executor: 'search_code', parameters };
}

describe('search_code grep proxy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-code-'));
  const executor = new SearchCodeToolExecutor(
    new FileReadService({
      root: dir,
      filterPaths: ['node_modules', 'logs', 'data', 'config.json'],
      filterExtensions: [],
    }),
  );

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns grep lines for any text file and skips secret and denylisted trees', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    mkdirSync(join(dir, 'config.d'), { recursive: true });
    writeFileSync(join(dir, 'src', 'logger.ts'), 'needle-token in logger\n');
    writeFileSync(join(dir, 'notes.md'), 'needle-token in markdown\n');
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), 'needle-token in deps\n');
    writeFileSync(join(dir, 'logs', 'app.txt'), 'needle-token in logs\n');
    writeFileSync(join(dir, 'config.json'), 'needle-token in config\n');
    writeFileSync(join(dir, 'config.d', 'keys.txt'), 'needle-token synthetic-secret\n');
    writeFileSync(join(dir, '.env'), 'needle-token env-secret\n');

    const result = await executor.execute(searchCall({ pattern: 'needle-token' }), context);
    expect(result.success).toBe(true);
    expect(result.reply).toContain('src/logger.ts:');
    expect(result.reply).toContain('needle-token in logger');
    expect(result.reply).toContain('notes.md:');
    expect(result.reply).toContain('needle-token in markdown');
    expect(result.reply).not.toContain('in deps');
    expect(result.reply).not.toContain('in logs');
    expect(result.reply).not.toContain('in config');
    expect(result.reply).not.toContain('synthetic-secret');
    expect(result.reply).not.toContain('env-secret');
    expect(result.reply).not.toContain('config.d');
  });

  it('keeps a long matching line intact', async () => {
    const body = `wide ${'x'.repeat(500)}`;
    writeFileSync(join(dir, 'src', 'wide.ts'), `${body}\n`);
    const result = await executor.execute(searchCall({ pattern: 'wide ', path: 'src/wide.ts' }), context);
    expect(result.success).toBe(true);
    expect(result.reply).toContain(body);
    expect(result.reply).not.toContain('...');
  });

  it('passes context, glob, ignoreCase, and fixed through to grep', async () => {
    writeFileSync(join(dir, 'src', 'fn.ts'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(dir, 'src', 'case.ts'), 'HelloWorld\n');
    writeFileSync(join(dir, 'src', 'literal.ts'), 'a.c\nabc\n');

    const around = await executor.execute(searchCall({ pattern: 'beta', path: 'src/fn.ts', context: 1 }), context);
    expect(around.success).toBe(true);
    expect(around.reply).toContain('alpha');
    expect(around.reply).toContain('beta');
    expect(around.reply).toContain('gamma');

    const onlyMd = await executor.execute(searchCall({ pattern: 'needle-token', glob: '*.md' }), context);
    expect(onlyMd.success).toBe(true);
    expect(onlyMd.reply).toContain('notes.md:');
    expect(onlyMd.reply).not.toContain('logger.ts');

    const folded = await executor.execute(
      searchCall({ pattern: 'helloworld', path: 'src/case.ts', ignoreCase: true }),
      context,
    );
    expect(folded.success).toBe(true);
    expect(folded.reply).toContain('HelloWorld');

    const literal = await executor.execute(
      searchCall({ pattern: 'a.c', path: 'src/literal.ts', fixed: true }),
      context,
    );
    expect(literal.success).toBe(true);
    expect(literal.reply).toContain('a.c');
    expect(literal.reply).not.toContain('abc');

    const either = await executor.execute(searchCall({ pattern: 'alpha|gamma', path: 'src/fn.ts' }), context);
    expect(either.success).toBe(true);
    expect(either.reply).toContain('alpha');
    expect(either.reply).toContain('gamma');
    expect(either.reply).not.toContain('beta');
  });

  it('rejects traversal, secret roots, and a missing path', async () => {
    const escaped = await executor.execute(searchCall({ pattern: 'x', path: '../' }), context);
    expect(escaped.success).toBe(false);
    expect(escaped.reply).toContain('项目根目录');

    const secrets = await executor.execute(searchCall({ pattern: 'x', path: 'config.d' }), context);
    expect(secrets.success).toBe(false);
    expect(secrets.reply).toContain('unavailable path');

    const envFile = await executor.execute(searchCall({ pattern: 'x', path: '.env' }), context);
    expect(envFile.success).toBe(false);

    const missing = await executor.execute(searchCall({ pattern: 'x', path: 'no/such' }), context);
    expect(missing.success).toBe(false);
    expect(missing.reply).toContain('路径不存在');

    const logsDir = await executor.execute(searchCall({ pattern: 'x', path: 'logs' }), context);
    expect(logsDir.success).toBe(false);

    mkdirSync(join(dir, 'database'), { recursive: true });
    writeFileSync(join(dir, 'database', 'note.txt'), 'segment-ok\n');
    const database = await executor.execute(searchCall({ pattern: 'segment-ok', path: 'database' }), context);
    expect(database.success).toBe(true);
    expect(database.reply).toContain('database/note.txt:');
    expect(database.reply).toContain('segment-ok');

    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'COMMIT_EDITMSG'), 'git-object-needle\n');
    writeFileSync(join(dir, 'src', 'plain.ts'), 'git-object-needle\n');
    const fromRoot = await executor.execute(searchCall({ pattern: 'git-object-needle' }), context);
    expect(fromRoot.success).toBe(true);
    expect(fromRoot.reply).toContain('src/plain.ts:');
    expect(fromRoot.reply).not.toContain('COMMIT_EDITMSG');

    const fromGit = await executor.execute(searchCall({ pattern: 'git-object-needle', path: '.git' }), context);
    expect(fromGit.success).toBe(true);
    expect(fromGit.reply).toContain('COMMIT_EDITMSG');
  });

  it('cuts output at the character cap and tells the model to narrow the search', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `hit ${String(i).padStart(4, '0')}`);
    lines.push('hit TAIL_MARKER_SHOULD_BE_CUT');
    writeFileSync(join(dir, 'src', 'big.txt'), `${lines.join('\n')}\n`);

    const result = await executor.execute(searchCall({ pattern: 'hit', path: 'src/big.txt' }), context);
    expect(result.success).toBe(true);
    expect(result.reply?.includes('TAIL_MARKER_SHOULD_BE_CUT')).toBe(false);
    expect(result.reply?.endsWith(searchCodeTruncationNotice())).toBe(true);
    expect(result.reply?.length).toBeGreaterThan(SEARCH_CODE_MAX_CHARS);
  });
});
