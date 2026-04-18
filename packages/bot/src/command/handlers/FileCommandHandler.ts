// File command handlers - ls, cat, and fetch for project root file access

import { basename } from 'node:path';
import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { InfoCardData } from '@/services/card';
import { CardRenderer } from '@/services/card';
import type { FileReadService } from '@/services/file';
import { logger } from '@/utils/logger';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Ls command - list directory contents (ls-style)
 */
@Command({
  name: 'ls',
  description: 'List files in a directory (relative to project root)',
  usage: '/ls [path]',
  permissions: ['admin'],
})
@injectable()
export class LsCommand implements CommandHandler {
  name = 'ls';
  description = 'List files in a directory (relative to project root)';
  usage = '/ls [path]';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService) {}

  execute(args: string[], context: CommandContext): CommandResult {
    const path = args[0] ?? '.';
    const noCheck = !!context.metadata.isPrivileged;
    const result = this.fileReadService.listDirectory(path, noCheck);

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? '未知错误',
      };
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(result.content ?? '(空目录)');
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

/**
 * Cat command - read file content (image by default, or plain text with --text)
 */
@Command({
  name: 'cat',
  description:
    'Read file content (relative to project root). Default: render as image. Use --text to send as plain text for copying.',
  usage: '/cat <path> [--text]',
  permissions: ['user'],
})
@injectable()
export class CatCommand implements CommandHandler {
  name = 'cat';
  description =
    'Read file content (relative to project root). Default: render as image. Use --text to send as plain text for copying.';
  usage = '/cat <path> [--text]';

  private readonly argsConfig: ParserConfig = {
    options: {
      text: { property: 'plainText', type: 'boolean' },
    },
  };

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const { text: pathArg, options } = CommandArgsParser.parse<{ plainText?: boolean }>(args, this.argsConfig);
    const path = pathArg.trim();
    if (!path) {
      return {
        success: false,
        error: '请提供文件路径，例如: /cat README.md 或 /cat --text README.md',
      };
    }

    const noCheck = !!context.metadata.isPrivileged;
    const result = this.fileReadService.readFile(path, noCheck);
    if (!result.success) {
      return {
        success: false,
        error: result.error ?? '未知错误',
      };
    }

    const content = result.content ?? '';

    if (options.plainText) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.text(content);
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }

    // Caller renders as image (card); FileReadService only returns string content
    const cardData: InfoCardData = {
      type: 'info',
      title: basename(path),
      content,
      level: 'info',
    };
    const cardRenderer = CardRenderer.getInstance();
    const buffer = await cardRenderer.render(cardData, { provider: 'system' });
    const imageBase64 = buffer.toString('base64');

    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: imageBase64 });
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

/**
 * Fetch command - send a file from project root via QQ file upload API
 */
@Command({
  name: 'fetch',
  description: 'Send a file via QQ (Milky protocol upload API). Admins can use absolute paths.',
  usage: '/fetch <path>',
  permissions: ['admin'],
})
@injectable()
export class FetchCommand implements CommandHandler {
  name = 'fetch';
  description = 'Send a file via QQ (Milky protocol upload API). Admins can use absolute paths.';
  usage = '/fetch <path>';

  constructor(
    @inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const path = args.join(' ').trim();
    if (!path) {
      return {
        success: false,
        error: '请提供文件路径，例如: /fetch data/report.csv',
      };
    }

    // Resolve path (admin privilege bypass)
    const noCheck = !!context.metadata.isPrivileged;
    const { resolved, error } = this.fileReadService.resolvePath(path, noCheck);
    if (error) {
      return { success: false, error };
    }

    // Read file locally and encode to base64 (bot and Milky server are on different machines)
    const binaryResult = this.fileReadService.readFileBinary(path, noCheck);
    if (!binaryResult.success || !binaryResult.data) {
      return { success: false, error: binaryResult.error ?? '文件读取失败' };
    }

    const fileName = basename(resolved);
    const fileUri = `base64://${binaryResult.data.toString('base64')}`;

    try {
      await this.messageAPI.uploadFile(fileUri, fileName, context);

      logger.info(`[FetchCommand] File uploaded | path=${path} | fileName=${fileName}`);
      const messageBuilder = new MessageBuilder();
      messageBuilder.text(`✅ 文件已发送: ${fileName}`);
      return { success: true, segments: messageBuilder.build() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[FetchCommand] File upload failed | path=${path} | error=${msg}`);
      return { success: false, error: `文件发送失败: ${msg}` };
    }
  }
}
