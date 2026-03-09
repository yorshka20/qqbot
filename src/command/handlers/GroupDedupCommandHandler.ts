import { join } from 'node:path';
import { inject, injectable } from 'tsyringe';
import type { AIService } from '@/ai';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { InfoCardData } from '@/services/card';
import type { FileReadService } from '@/services/file';
import { formatBytes, runDeduplication } from '@/utils/fileDedup';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** Must match GroupDownloadPlugin.ts DOWNLOAD_ROOT */
const DOWNLOAD_ROOT = 'output/downloads';
const CARD_RENDER_THRESHOLD = 400;

@Command({
  name: 'dedup_group',
  description: '立即对指定群下载目录执行一次去重（管理员）',
  usage: '/dedup_group <groupId>',
  permissions: ['admin'],
  aliases: ['group_dedup', '群去重'],
})
@injectable()
export class GroupDedupCommandHandler implements CommandHandler {
  name = 'dedup_group';
  description = '立即对指定群下载目录执行一次去重（管理员）';
  usage = '/dedup_group <groupId>';

  constructor(
    @inject(DITokens.FILE_READ_SERVICE) private fileService: FileReadService,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
  ) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const groupId = args[0]?.trim();
    if (!groupId) {
      return {
        success: false,
        error: '请提供群号，例如：/dedup_group 123456',
      };
    }

    logger.info(`[GroupDedupCommandHandler] Starting manual dedup | groupId=${groupId}`);
    // Use same path resolution as DeduplicateFilesTaskExecutor and GroupDownloadPlugin (cwd + DOWNLOAD_ROOT)
    const targetDirAbsolute = join(process.cwd(), DOWNLOAD_ROOT, groupId);
    const targetDirRelative = `${DOWNLOAD_ROOT}/${groupId}`;
    // noCheck for resolvePath so message does not show "unavailable path" for the same path we scan (admin-only command)
    const resolvedTarget = this.fileService.resolvePath(targetDirRelative, true);
    const result = await runDeduplication([targetDirAbsolute], this.fileService, false);

    const lines: string[] = [
      `群 ${groupId} 去重完成：`,
      `- 扫描文件：${result.totalFiles} 个`,
      `- 发现重复：${result.duplicatesFound} 个`,
      `- 释放空间：${formatBytes(result.bytesFreed)}`,
    ];

    if (result.deletedFiles.length > 0) {
      const preview = result.deletedFiles
        .slice(0, 5)
        .map((file) => `  • ${file}`)
        .join('\n');
      const more = result.deletedFiles.length > 5 ? `\n  … 共 ${result.deletedFiles.length} 个` : '';
      lines.push(`- 已删除文件：\n${preview}${more}`);
    }

    const hasMissingDirError = result.errors.some((item) => item.error.includes('路径不存在'));
    if (hasMissingDirError && result.totalFiles === 0 && result.duplicatesFound === 0) {
      lines.push(`- 目录状态：未找到 ${targetDirRelative}，该群可能还没有下载文件`);
      lines.push(`- 实际扫描路径：${targetDirAbsolute}`);
    } else if (resolvedTarget.error) {
      lines.push(`- 路径检查：${targetDirRelative}（${resolvedTarget.error}）`);
    } else if (result.errors.length > 0) {
      lines.push(`- 错误：${result.errors.length} 个（详见日志）`);
    }

    const outputText = lines.join('\n');

    if (outputText.length >= CARD_RENDER_THRESHOLD) {
      const cardData: InfoCardData = {
        type: 'info',
        title: `群 ${groupId} 去重结果`,
        content: outputText,
        level: 'info',
      };
      try {
        const segments = await this.aiService.renderCardToSegments(JSON.stringify(cardData));
        return {
          success: true,
          segments,
          data: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        logger.warn('[GroupDedupCommandHandler] Card render failed, falling back to text:', err);
      }
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(outputText);
    return {
      success: true,
      segments: messageBuilder.build(),
      data: result as unknown as Record<string, unknown>,
    };
  }
}
