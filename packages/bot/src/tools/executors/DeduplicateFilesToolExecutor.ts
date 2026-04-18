// Deduplicate files task executor
// AI-triggered task that scans output/downloads group directories for content-identical duplicates.

import { join } from 'node:path';
import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FileReadService } from '@/services/file';
import { formatBytes, resolveGroupDirs, runDeduplication } from '@/utils/fileDedup';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Must match GroupDownloadPlugin.ts DOWNLOAD_ROOT */
const DOWNLOAD_ROOT = 'output/downloads';

@Tool({
  name: 'deduplicate_files',
  visibility: ['internal'],
  description:
    'Scan downloaded group media for content-identical duplicate files and remove them, keeping the oldest copy. Supports dry-run mode to preview results without deletion.',
  executor: 'deduplicate_files',
  parameters: {
    groupId: {
      type: 'string',
      required: false,
      description:
        'Group ID to deduplicate (e.g. "123456"). Omit to scan all group directories under output/downloads/',
    },
    dryRun: {
      type: 'boolean',
      required: false,
      description: 'When true, report duplicates without deleting anything. Default: false',
    },
  },
  examples: [
    '去重群 123456 的下载图片',
    '删除群里重复的图片和视频',
    '帮我去重所有群的下载文件',
    'deduplicate downloads for group 654321 dry run',
    '查看群 123456 有哪些重复文件（不删除）',
  ],
  triggerKeywords: ['去重', '重复', '重复文件', 'dedup', 'deduplicate', '清理下载', '删除重复'],
  whenToUse:
    'Use when user wants to remove duplicate downloaded images, videos, or stickers from a QQ group download directory. ' +
    'Supports dry-run mode to preview results without deletion.',
})
@injectable()
export class DeduplicateFilesToolExecutor extends BaseToolExecutor {
  name = 'deduplicate_files';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileService: FileReadService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const groupIdParam = call.parameters?.groupId as string | undefined;
    const dryRun = call.parameters?.dryRun === true;

    logger.info(`[DeduplicateFilesToolExecutor] Starting dedup | groupId=${groupIdParam ?? 'all'} | dryRun=${dryRun}`);

    const dirs = resolveGroupDirs(join(getRepoRoot(), DOWNLOAD_ROOT), groupIdParam);
    if (dirs.length === 0) {
      return this.success(`未找到任何群下载目录（${DOWNLOAD_ROOT}）。`, {
        totalFiles: 0,
        duplicatesFound: 0,
        bytesFreed: 0,
        deletedFiles: [],
        errors: [],
      });
    }

    const result = await runDeduplication(dirs, this.fileService, dryRun);
    const reply = this.formatReply(result, dryRun, groupIdParam);
    return this.success(reply, result as unknown as Record<string, unknown>);
  }

  private formatReply(
    result: ReturnType<typeof runDeduplication> extends Promise<infer R> ? R : never,
    dryRun: boolean,
    groupId: string | undefined,
  ): string {
    const scope = groupId ? `群 ${groupId}` : '所有群';
    const action = dryRun ? '（试运行，未删除）' : '';

    if (result.duplicatesFound === 0) {
      return `${scope} 下载目录扫描完成${action}：共 ${result.totalFiles} 个文件，未发现重复。`;
    }

    const freed = formatBytes(result.bytesFreed);
    const lines: string[] = [
      `${scope} 去重完成${action}：`,
      `- 扫描文件：${result.totalFiles} 个`,
      `- 发现重复：${result.duplicatesFound} 个`,
      `- 释放空间：${freed}`,
    ];

    if (result.deletedFiles.length > 0) {
      const preview = result.deletedFiles
        .slice(0, 5)
        .map((f) => `  • ${f}`)
        .join('\n');
      const more = result.deletedFiles.length > 5 ? `\n  … 共 ${result.deletedFiles.length} 个` : '';
      lines.push(`- ${dryRun ? '待删除' : '已删除'}文件：\n${preview}${more}`);
    }

    if (result.errors.length > 0) {
      lines.push(`- 错误：${result.errors.length} 个（详见 data.errors）`);
    }

    return lines.join('\n');
  }
}
