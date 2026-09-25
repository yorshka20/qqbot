// SearchCode tool executor — a grep proxy. The model already knows pattern, path,
// glob, and context; the only limits applied here are the output cap and the
// path denylist (secrets, traversal, configured directory names).

import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { inject, injectable } from 'tsyringe';
import { FileReadService } from '@/services/file/FileReadService';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

export const SEARCH_CODE_MAX_CHARS = 48_000;

const SEARCH_TIMEOUT_MS = 20_000;

export function searchCodeTruncationNotice(): string {
  return (
    `[已截断] 只保留了前 ${SEARCH_CODE_MAX_CHARS} 个字符。` +
    '请收窄 pattern、path 或 glob，或减小 context，不要用同样的参数再搜一次。'
  );
}

@Tool({
  name: 'search_code',
  description:
    '用 grep -E 在项目里搜文本，参数和 grep / rg 相同。pattern 是扩展正则（|、+、() 直接写）；path 限定文件或目录；glob 等同 --include（如 *.ts、*.md）；context 是 -C 上下文行数；ignoreCase 是 -i；fixed 为 true 时 pattern 按字面量匹配（-F）。结果是 path:line:内容。只限制两件事：输出有字符上限，以及密钥和被禁止的路径不可搜。',
  executor: 'search_code',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true }, subagent: true },
  parameters: {
    pattern: {
      type: 'string',
      required: true,
      description: 'grep -E 的 pattern（扩展正则，| + () 直接写）。fixed 为 true 时改为字面量。',
    },
    path: {
      type: 'string',
      required: false,
      description: 'grep 的路径，相对项目根。不填则从项目根搜索。想少返回结果就把它收窄，例如 packages/bot/src。',
    },
    glob: {
      type: 'string',
      required: false,
      description: '等同 grep --include / rg --glob，例如 *.ts 或 *.md。不填则搜索所有文本文件。',
    },
    context: {
      type: 'number',
      required: false,
      description: '等同 grep -C。匹配行上下各保留的行数，默认 0。',
    },
    ignoreCase: {
      type: 'boolean',
      required: false,
      description: '等同 grep -i。为 true 时忽略大小写。',
    },
    fixed: {
      type: 'boolean',
      required: false,
      description: '等同 grep -F。为 true 时 pattern 按字面量匹配，不作为正则。',
    },
  },
  examples: [
    '搜索一下记忆功能的实现',
    'bot的图片生成代码在哪里',
    '帮我看看proactive相关的代码',
    '找一下CommandManager的定义',
  ],
  triggerKeywords: ['源码', '代码', '实现', 'source', 'grep', '代码搜索'],
  whenToUse:
    '不知道代码在哪、或只要匹配片段和上下文时用这个，不要先整文件 read_file。参数用法和 grep 一样：用 path 和 glob 收窄，用 context 带上前后文。结果被截断就收窄 pattern、path 或 glob，或减小 context，不要原样再搜。已知文件且需要连续的一大段时再用 read_file。',
})
@injectable()
export class SearchCodeToolExecutor extends BaseToolExecutor {
  name = 'search_code';

  constructor(@inject(FileReadService) private fileReadService: FileReadService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const pattern = typeof call.parameters?.pattern === 'string' ? call.parameters.pattern : '';
    if (pattern.trim().length === 0) {
      return this.error('请提供搜索 pattern', 'Missing required parameter: pattern');
    }

    const rawPath = call.parameters?.path;
    const pathParam = typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath.trim() : '.';
    const glob = parseGlob(call.parameters?.glob);
    if (glob.error) {
      return this.error(glob.error, 'Invalid glob');
    }
    const contextLines = parseContext(call.parameters?.context);
    if (typeof contextLines === 'string') {
      return this.error(contextLines, 'Invalid context');
    }

    const { resolved, error } = this.fileReadService.resolveWalkPath(pathParam);
    if (error || !resolved) {
      return this.error(error ?? '路径不可用', error ?? 'Path rejected');
    }
    if (!existsSync(resolved)) {
      return this.error('路径不存在', 'Path does not exist');
    }

    const root = this.fileReadService.resolveWalkPath('.').resolved;
    if (!root) {
      return this.error('路径不可用', 'Project root rejected');
    }
    const searchArg = relative(root, resolved) || '.';
    const searchingGit = searchArg === '.git' || searchArg.startsWith('.git/');
    const excludes = this.fileReadService
      .grepExcludeArgs()
      .filter((arg) => !searchingGit || arg !== '--exclude-dir=.git');
    const args = ['grep', '-rIn', '--color=never', ...excludes];
    if (asBool(call.parameters?.ignoreCase)) {
      args.push('-i');
    }
    if (asBool(call.parameters?.fixed)) {
      args.push('-F');
    } else {
      args.push('-E');
    }
    if (contextLines > 0) {
      args.push('-C', String(contextLines));
    }
    if (glob.value) {
      args.push(`--include=${glob.value}`);
    }
    args.push('--', pattern, searchArg);

    try {
      const { text, truncated, exitCode, stderr } = await runGrep(args, root);
      const shown = presentGrep(text);
      if (!shown) {
        if (exitCode !== 0 && exitCode !== 1 && !truncated) {
          const detail = stderr.trim() || `退出码 ${exitCode}`;
          logger.warn(`[SearchCodeToolExecutor] grep error: ${detail}`);
          return this.error(`搜索出错: ${detail}`, detail);
        }
        return this.success(`未找到匹配 "${pattern}"。`, { pattern, path: pathParam, truncated: false });
      }
      const notice = truncated ? `\n\n${searchCodeTruncationNotice()}` : '';
      return this.success(`${shown}${notice}`, { pattern, path: pathParam, truncated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`[SearchCodeToolExecutor] Error: ${msg}`);
      return this.error(`搜索失败: ${msg}`, msg);
    }
  }
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseContext(value: unknown): number | string {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    return 'context 必须是非负整数，对应 grep -C';
  }
  return n;
}

function parseGlob(value: unknown): { value?: string; error?: string } {
  if (value === undefined || value === null || value === '') {
    return {};
  }
  if (typeof value !== 'string') {
    return { error: 'glob 必须是字符串，例如 *.ts' };
  }
  const glob = value.trim();
  if (!glob) {
    return {};
  }
  if (glob.startsWith('-') || glob.includes('\0') || glob.includes('\n') || glob.includes('\r')) {
    return { error: 'glob 无效' };
  }
  return { value: glob };
}

const GREP_LINE = /^(.+?)([:-])(\d+)\2/;

function isSecretLine(line: string): boolean {
  const match = GREP_LINE.exec(line);
  const path = match ? match[1] : line;
  return path
    .split(/[/\\]/)
    .some((segment) => segment === 'config.d' || segment === '.env' || segment.startsWith('.env.'));
}

function presentGrep(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const shown = line.startsWith('./') ? line.slice(2) : line;
    if (!shown || isSecretLine(shown)) {
      continue;
    }
    kept.push(shown);
  }
  return kept.join('\n');
}

async function runGrep(
  args: string[],
  cwd: string,
): Promise<{ text: string; truncated: boolean; exitCode: number | null; stderr: string }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SEARCH_TIMEOUT_MS);
  const stderrPromise = new Response(proc.stderr).text();

  let text = '';
  let truncated = false;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length > SEARCH_CODE_MAX_CHARS) {
        text = text.slice(0, SEARCH_CODE_MAX_CHARS);
        truncated = true;
        await reader.cancel();
        proc.kill();
        break;
      }
    }
    if (!truncated) {
      text += decoder.decode();
    }
  } finally {
    clearTimeout(timer);
  }

  const stderr = await stderrPromise;
  const exitCode = await proc.exited;
  if (timedOut && text.length > 0) {
    truncated = true;
  }
  return { text, truncated, exitCode, stderr };
}
