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

    const targetDir = join(DOWNLOAD_ROOT, groupId);
    const dirCheck = this.fileService.scanDirectory(targetDir);
    if (!dirCheck.success) {
      return {
        success: false,
        error: `群 ${groupId} 下载目录不可用：${targetDir}（${dirCheck.error ?? '未知错误'}）`,
      };
    }

    logger.info(`[GroupDedupCommandHandler] Starting manual dedup | groupId=${groupId}`);
    const result = await runDeduplication([targetDir], this.fileService, false);

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

    if (result.errors.length > 0) {
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
