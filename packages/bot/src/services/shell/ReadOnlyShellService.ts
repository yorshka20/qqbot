// ReadOnlyShellService — runs a single read-only inspection command in the repo root.
//
// There is deliberately NO shell here: the command line is tokenized in-process and
// spawned as argv. Without a shell there is no piping, no redirection, no command
// chaining, no glob/variable expansion — which is what makes a denylist-free secret
// boundary possible (a real shell can always be talked into `cat con*/ai*`). What
// remains is a per-binary allowlist plus one uniform rule: any argument that
// resolves to an existing filesystem path must pass FileReadService's read checks
// (project containment + config.d/.env hard denial).

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileReadService } from '@/services/file';
import { logger } from '@/utils/logger';

const TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 10_000;

export interface ShellRunResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Read-only git subcommands. Global git options are structurally impossible: the
 * token right after `git` must be one of these, so `-c key=val` / `--exec-path`
 * (which execute arbitrary programs) never parse.
 */
const GIT_SUBCOMMANDS = new Set([
  'log',
  'show',
  'diff',
  'status',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'rev-list',
  'ls-files',
  'grep',
  'reflog',
  'branch',
  'tag',
]);

/**
 * Flags that make an otherwise read-only git subcommand write files or execute
 * external programs (pager/diff driver), in any position.
 */
const GIT_FORBIDDEN_FLAGS: RegExp[] = [
  /^--output(-directory)?(=|$)/,
  /^--ext-diff$/,
  /^-O/, // git grep --open-files-in-pager: runs the pager
  /^--open-files-in-pager/,
  /^--upload-pack/,
  /^--receive-pack/,
];

/** branch/tag flags that mutate refs. */
const GIT_BRANCH_FORBIDDEN = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '-f',
  '--force',
  '--delete',
  '--move',
  '--copy',
  '--edit-description',
  '--set-upstream-to',
  '-u',
  '--unset-upstream',
  '-t',
  '--track',
]);
const GIT_TAG_FORBIDDEN = new Set(['-a', '-s', '-u', '-f', '--force', '-d', '--delete', '-e', '--edit', '-F', '-m']);

/** branch/tag flags that mark the invocation as a pure query (positionals allowed). */
const GIT_LIST_QUERY_FLAGS = [
  '-l',
  '--list',
  '--contains',
  '--no-contains',
  '--points-at',
  '--merged',
  '--no-merged',
  '--sort',
  '--format',
  '-n',
];

/**
 * rg/grep flags that either execute external programs (--pre) or disable the
 * ignore rules that keep gitignored secret dirs out of recursive searches.
 * Pattern-from-file flags are blocked because the file's content becomes an
 * error-message leak channel.
 */
const SEARCH_FORBIDDEN_FLAGS: RegExp[] = [
  /^--pre(=|$)/,
  /^--pre-glob(=|$)/,
  /^--no-ignore/,
  /^-u+$/,
  /^--unrestricted$/,
  /^--ignore-file(=|$)/,
  /^-f$/,
  /^--file(=|$)/,
  /^--exclude-from(=|$)/,
  /^--include-from(=|$)/,
];

const ALLOWED_BINARIES = new Set(['git', 'rg', 'grep', 'ls', 'cat', 'head', 'tail', 'wc']);

const SHELL_SYNTAX_ERROR =
  '不支持 shell 语法（管道/重定向/命令串联/变量展开），一次只能执行一条命令。正则等含特殊字符的参数请用引号包裹。';

export class ReadOnlyShellService {
  constructor(
    private readonly fileReadService: FileReadService,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  run(command: string): ShellRunResult {
    const parsed = tokenize(command);
    if ('error' in parsed) {
      return { success: false, output: '', error: parsed.error };
    }
    const tokens = parsed.tokens;
    if (tokens.length === 0) {
      return { success: false, output: '', error: '命令为空' };
    }

    const [bin, ...args] = tokens;
    if (!ALLOWED_BINARIES.has(bin)) {
      return {
        success: false,
        output: '',
        error: `不支持的命令：${bin}。可用：${[...ALLOWED_BINARIES].join(' / ')}（仅只读检查）`,
      };
    }

    const policyError = this.checkPolicy(bin, args);
    if (policyError) {
      return { success: false, output: '', error: policyError };
    }

    const pathError = this.validateArgPaths(args);
    if (pathError) {
      return { success: false, output: '', error: pathError };
    }

    return this.spawn(bin, this.finalizeArgs(bin, args));
  }

  // ── policy ──────────────────────────────────────────────────────────

  private checkPolicy(bin: string, args: string[]): string | null {
    if (bin === 'git') return ReadOnlyShellService.checkGitPolicy(args);
    if (bin === 'rg' || bin === 'grep') {
      const hit = args.find((a) => SEARCH_FORBIDDEN_FLAGS.some((re) => re.test(a)));
      return hit ? `参数不可用：${hit}（会绕过忽略规则或执行外部程序）` : null;
    }
    return null;
  }

  private static checkGitPolicy(args: string[]): string | null {
    const sub = args[0];
    if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
      return `git 仅支持只读子命令：${[...GIT_SUBCOMMANDS].join(' / ')}（子命令必须紧跟在 git 之后）`;
    }
    const rest = args.slice(1);
    const forbidden = rest.find((a) => GIT_FORBIDDEN_FLAGS.some((re) => re.test(a)));
    if (forbidden) {
      return `git 参数不可用：${forbidden}`;
    }
    if (sub === 'branch' || sub === 'tag') {
      const mutating = sub === 'branch' ? GIT_BRANCH_FORBIDDEN : GIT_TAG_FORBIDDEN;
      const hit = rest.find((a) => mutating.has(a));
      if (hit) {
        return `git ${sub} 仅支持查询，参数不可用：${hit}`;
      }
      // A bare positional creates a ref (`git tag v1`); positionals are only
      // meaningful together with a list/query flag.
      const hasPositional = rest.some((a) => !a.startsWith('-'));
      const hasQueryFlag = rest.some((a) => GIT_LIST_QUERY_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
      if (hasPositional && !hasQueryFlag) {
        return `git ${sub} 带位置参数会创建引用；查询请配合 --list/--contains 等参数`;
      }
    }
    return null;
  }

  /**
   * Uniform path rule: any argument (or `--flag=value` value) that resolves to an
   * existing filesystem path must be inside the project root and pass
   * FileReadService's read checks — this is the same config.d/.env boundary as
   * read_file, applied to command arguments. Non-path arguments (refs, patterns,
   * numbers) resolve to nothing and pass through.
   */
  private validateArgPaths(args: string[]): string | null {
    for (const raw of args) {
      const candidates: string[] = [];
      if (raw.startsWith('-')) {
        const eq = raw.indexOf('=');
        if (eq > 0 && eq < raw.length - 1) candidates.push(raw.slice(eq + 1));
      } else {
        candidates.push(raw);
      }
      for (const cand of candidates) {
        if (!cand || cand === '-' || cand === '--') continue;
        const abs = resolve(this.projectRoot, cand);
        if (!existsSync(abs)) continue;
        let real = abs;
        try {
          real = realpathSync(abs);
        } catch {
          // stat raced away — treat as the resolved path
        }
        const rel = relative(this.projectRoot, real);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return `路径超出项目根目录：${cand}`;
        }
        const { error } = this.fileReadService.resolvePath(rel === '' ? '.' : rel, false, true);
        if (error) {
          return `不可访问的路径：${cand}（${error}）`;
        }
      }
    }
    return null;
  }

  /** Forced hardening args appended after user args. */
  private finalizeArgs(bin: string, args: string[]): string[] {
    if (bin === 'grep') {
      // plain grep ignores .gitignore — keep recursive searches out of the secret dirs
      return [...args, '--exclude-dir=config.d', '--exclude=.env', '--exclude=.env.*'];
    }
    if (bin === 'rg') {
      // rg honors .gitignore already; these hold even if that changes
      return [...args, '--iglob', '!config.d/**', '--iglob', '!**/.env*'];
    }
    return args;
  }

  // ── execution ───────────────────────────────────────────────────────

  private spawn(bin: string, args: string[]): ShellRunResult {
    const result = spawnSync(bin, args, {
      cwd: this.projectRoot,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        // Neutralize every configurable program-execution hook git has.
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });

    if (result.error) {
      const msg = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '命令执行超时' : result.error.message;
      logger.warn(`[ReadOnlyShellService] spawn failed: ${bin}`, result.error);
      return { success: false, output: '', error: msg };
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    let output = stdout + (stderr.trim() ? `${stdout.trim() ? '\n' : ''}[stderr] ${stderr.trim()}` : '');
    if (output.length > MAX_OUTPUT_CHARS) {
      output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n…（输出已截断）`;
    }
    if (result.status !== 0) {
      return { success: false, output, error: `命令退出码 ${result.status}${output ? `：\n${output}` : ''}` };
    }
    return { success: true, output: output.trim() ? output : '（无输出）' };
  }
}

/**
 * Quote-aware tokenizer with NO expansion of any kind. Unquoted shell operator
 * characters are rejected up front — not as a security measure (there is no shell
 * to exploit), but so "git log | head" fails with a clear message instead of
 * passing "|" to git as a literal argument.
 */
function tokenize(input: string): { tokens: string[] } | { error: string } {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '`') {
      return { error: SHELL_SYNTAX_ERROR };
    }
    if (ch === '$' && input[i + 1] === '(') {
      return { error: SHELL_SYNTAX_ERROR };
    }
    if (/\s/.test(ch)) {
      if (hasCurrent || current) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    return { error: '引号未闭合' };
  }
  if (hasCurrent || current) {
    tokens.push(current);
  }
  return { tokens };
}
