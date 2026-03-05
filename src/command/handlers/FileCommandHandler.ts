// File command handlers - ls and cat for project root file access

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { FileReadService } from '@/services/file';
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

  execute(args: string[], _context: CommandContext): CommandResult {
    const path = args[0] ?? '.';
    const result = this.fileReadService.listDirectory(path);

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
 * Cat command - read file content and render as image
 */
@Command({
  name: 'cat',
  description: 'Read file content and display as image (relative to project root)',
  usage: '/cat <path>',
  permissions: ['user'],
})
@injectable()
export class CatCommand implements CommandHandler {
  name = 'cat';
  description = 'Read file content and display as image (relative to project root)';
  usage = '/cat <path>';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const path = args[0];
    if (!path) {
      return {
        success: false,
        error: '请提供文件路径，例如: /cat README.md',
      };
    }

    const result = await this.fileReadService.readFileAsImage(path);

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? '未知错误',
      };
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: result.imageBase64! });
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}
