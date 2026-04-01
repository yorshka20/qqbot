// File command handlers - ls and cat for project root file access

import { basename } from 'node:path';
import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { InfoCardData } from '@/services/card';
import { CardRenderer } from '@/services/card';
import type { FileReadService } from '@/services/file';
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
