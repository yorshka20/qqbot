// Read file task executor - handles file listing and file content reading

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FileReadService } from '@/services/file';
import { logger } from '@/utils/logger';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * Read file task executor
 * Handles listing directory contents and reading file content (rendered as image)
 */
@TaskDefinition({
  name: 'read_file',
  description: 'List directory contents or read file content within project root',
  executor: 'read_file',
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Path relative to project root (e.g. src, README.md)',
    },
    action: {
      type: 'string',
      required: true,
      description: "Action: 'list' for directory listing, 'read' for file content",
    },
  },
  examples: ['查看 src 下的文件', '读取 README.md 内容', '列出根目录文件'],
  triggerKeywords: ['读取', '查看', '文件列表', '文件内容', 'read', 'list', 'ls', 'file'],
  whenToUse:
    'Use when user asks to list files in a directory or read file content. Root is project root. Path must not escape project root.',
})
@injectable()
export class ReadFileTaskExecutor extends BaseTaskExecutor {
  name = 'read_file';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService) {
    super();
  }

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    const path = task.parameters?.path as string | undefined;
    const action = task.parameters?.action as string | undefined;

    if (!path) {
      return this.error('请提供路径', 'Missing required parameter: path');
    }

    if (!action || (action !== 'list' && action !== 'read')) {
      return this.error('请指定操作: list（列出目录）或 read（读取文件）', 'Invalid action');
    }

    logger.info(`[ReadFileTaskExecutor] Executing ${action} for path: ${path}`);

    if (action === 'list') {
      const result = this.fileReadService.listDirectory(path);
      if (!result.success) {
        return this.error(result.error ?? '未知错误', result.error ?? 'listDirectory failed');
      }
      return this.success(result.content ?? '', { action: 'list', path });
    }

    // action === 'read'
    const result = await this.fileReadService.readFileAsImage(path);
    if (!result.success) {
      return this.error(result.error ?? '未知错误', result.error ?? 'readFileAsImage failed');
    }

    return this.success('[文件内容已渲染为图片]', {
      action: 'read',
      path,
      imageBase64: result.imageBase64,
      isImageReply: true,
    });
  }
}
