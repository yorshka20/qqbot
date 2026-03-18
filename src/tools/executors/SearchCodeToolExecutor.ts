// SearchCode tool executor — greps bot source code for keywords/patterns

import { join, relative } from 'node:path';
import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FileReadService } from '@/services/file';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const MAX_RESULTS = 30;
const MAX_LINE_LENGTH = 200;
const PROJECT_ROOT = process.cwd();

@Tool({
  name: 'search_code',
  description:
    '在 bot 源代码中搜索关键词或正则表达式。返回匹配的文件路径、行号和代码片段。用于解释功能实现细节或帮助用户了解 bot 的工作原理。',
  executor: 'search_code',
  visibility: ['reply', 'subagent'],
  parameters: {
    pattern: {
      type: 'string',
      required: true,
      description: '搜索关键词或短语（如 "MemoryService"、"proactive"、"图片生成"）',
    },
    path: {
      type: 'string',
      required: false,
      description: '限定搜索目录（相对于项目根），默认 src/',
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
    '当不确定某个功能在哪个文件、需要按关键词定位代码时调用。找到文件后如需查看完整内容，再用 read_file 读取。',
})
@injectable()
export class SearchCodeToolExecutor extends BaseToolExecutor {
  name = 'search_code';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileService: FileReadService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const pattern = call.parameters?.pattern as string | undefined;
    const pathParam = (call.parameters?.path as string | undefined) ?? 'src/';

    if (!pattern || pattern.trim().length === 0) {
      return this.error('请提供搜索关键词', 'Missing required parameter: pattern');
    }

    if (pattern.length > 200) {
      return this.error('搜索关键词过长（最多 200 字符）', 'Pattern too long');
    }

    // Resolve and validate path
    const searchPath = join(PROJECT_ROOT, pathParam);
    if (!searchPath.startsWith(PROJECT_ROOT)) {
      return this.error('路径不能逃逸出项目根目录', 'Path escapes project root');
    }

    try {
      const proc = Bun.spawn(
        [
          'grep',
          '-rn',
          '--include=*.ts',
          '--include=*.json',
          '-m',
          String(MAX_RESULTS),
          '--',
          pattern.trim(),
          searchPath,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (stderr && proc.exitCode !== 0 && proc.exitCode !== 1) {
        logger.warn(`[SearchCodeToolExecutor] grep error: ${stderr}`);
        return this.error(`搜索出错: ${stderr.trim()}`, stderr.trim());
      }

      const lines = stdout.trim().split('\n').filter(Boolean);

      if (lines.length === 0) {
        return this.success(`未找到匹配 "${pattern}" 的代码。`, {
          pattern,
          path: pathParam,
          totalMatches: 0,
          matches: [],
        });
      }

      const matches = lines.map((line) => {
        // Format: filepath:linenum:content
        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        const filePath = relative(PROJECT_ROOT, line.substring(0, firstColon));
        const lineNum = line.substring(firstColon + 1, secondColon);
        let content = line.substring(secondColon + 1).trim();
        if (content.length > MAX_LINE_LENGTH) {
          content = `${content.substring(0, MAX_LINE_LENGTH)}...`;
        }
        return { file: filePath, line: lineNum, content };
      });

      const formatted = matches.map((m) => `${m.file}:${m.line}: ${m.content}`).join('\n');

      const truncated = lines.length >= MAX_RESULTS ? `\n\n（结果已截断，仅显示前 ${MAX_RESULTS} 条）` : '';

      return this.success(
        `搜索 "${pattern}" 在 ${pathParam} 中找到 ${matches.length} 条匹配:\n\n${formatted}${truncated}`,
        {
          pattern,
          path: pathParam,
          totalMatches: matches.length,
          matches,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`[SearchCodeToolExecutor] Error: ${msg}`);
      return this.error(`搜索失败: ${msg}`, msg);
    }
  }
}
