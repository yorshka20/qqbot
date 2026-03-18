// Read file task executor - handles file listing and file content reading

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FileReadService } from '@/services/file';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Read file task executor
 * Handles listing directory contents and reading file content (text only; card render is caller's responsibility).
 * List and read are implemented as separate methods for easier extension (e.g. stat, exists).
 */
@Tool({
  name: 'read_file',
  description:
    '列出目录内容或读取指定文件全文。部分路径出于安全原因被禁止访问（如含 API key 的配置文件、node_modules、.env、.git 等），被拒绝时会返回错误而非文件内容。如果不知道文件位置，请先用 search_code 搜索。',
  executor: 'read_file',
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: '相对于项目根目录的路径（如 src、README.md、prompts/base.md）',
    },
    action: {
      type: 'string',
      required: true,
      description: "'list' 列出目录内容，'read' 读取文件文本",
    },
  },
  examples: ['查看 src 下的文件', '读取 README.md 内容', '列出根目录文件'],
  triggerKeywords: ['读取', '查看', '文件列表', '文件内容', 'read', 'list', 'ls', 'file'],
  whenToUse:
    '当已知具体文件路径、需要读取完整内容时调用。如果不确定文件在哪，先用 search_code 定位。路径不能逃逸出项目根目录。注意：config.jsonc、.env 等含敏感信息的文件会被安全策略拒绝，返回错误时不要反复重试，告知用户该文件受限即可。',
})
@injectable()
export class ReadFileToolExecutor extends BaseToolExecutor {
  name = 'read_file';

  constructor(@inject(DITokens.FILE_READ_SERVICE) private fileReadService: FileReadService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const path = call.parameters?.path as string | undefined;
    const action = call.parameters?.action as string | undefined;

    if (!path) {
      return this.error('请提供路径', 'Missing required parameter: path');
    }

    if (!action || (action !== 'list' && action !== 'read')) {
      return this.error('请指定操作: list（列出目录）或 read（读取文件）', 'Invalid action');
    }

    logger.info(`[ReadFileToolExecutor] Executing ${action} for path: ${path}`);

    if (action === 'list') {
      return this.executeList(path);
    }

    return this.executeRead(path);
  }

  /**
   * List directory contents (ls-style). Extracted for extension (e.g. future stat/glob).
   */
  private executeList(path: string): ToolResult {
    const result = this.fileReadService.listDirectory(path);
    if (!result.success) {
      return this.error(result.error ?? '未知错误', result.error ?? 'listDirectory failed');
    }
    const content = result.content ?? '';
    return this.success(content, { action: 'list', path, content });
  }

  /**
   * Read file content as text. Extracted for extension (e.g. future readLines, grep).
   */
  private executeRead(path: string): ToolResult {
    const result = this.fileReadService.readFile(path);
    if (!result.success) {
      return this.error(result.error ?? '未知错误', result.error ?? 'readFile failed');
    }
    const content = result.content ?? '';
    return this.success('文件已读取', {
      action: 'read',
      path,
      content,
    });
  }
}
