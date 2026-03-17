// ReadFileExecutor - safely reads project files with optional line range

import * as path from 'node:path';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

export class ReadFileExecutor extends BaseToolExecutor {
  name = 'read_file';

  definition: ToolDefinition = {
    name: 'read_file',
    description: '读取项目中的文件内容。支持指定行范围。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '文件路径（相对于项目根目录）。',
      },
      startLine: {
        type: 'number',
        required: false,
        description: '起始行号（1-indexed）。不指定则从头开始。',
      },
      endLine: {
        type: 'number',
        required: false,
        description: '结束行号。不指定则读到末尾。',
      },
      encoding: {
        type: 'string',
        required: false,
        description: '文件编码。默认 utf-8。',
      },
    },
    examples: [
      'read_file path="src/index.ts"',
      'read_file path="package.json"',
      'read_file path="src/services/claudeCode/ClaudeCodeService.ts" startLine=1 endLine=50',
    ],
    whenToUse: '当需要查看文件内容、了解实现细节或参考现有代码时使用。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const filePath = parameters.path as string;
    const startLine = parameters.startLine as number | undefined;
    const endLine = parameters.endLine as number | undefined;

    if (!filePath) {
      return this.error('Missing required parameter: path');
    }

    // Security: resolve and verify the path stays within the working directory
    const resolvedPath = path.resolve(this.workingDirectory, filePath);
    if (!resolvedPath.startsWith(this.workingDirectory)) {
      return this.error(`Path is outside the project directory: ${filePath}`);
    }

    logger.debug(`[ReadFileExecutor] Reading file: ${resolvedPath}`);

    try {
      const file = Bun.file(resolvedPath);
      const exists = await file.exists();
      if (!exists) {
        return this.error(`File not found: ${filePath}`);
      }

      const content = await file.text();
      const lines = content.split('\n');
      const totalLines = lines.length;

      let selectedLines: string[];
      if (startLine !== undefined || endLine !== undefined) {
        const start = Math.max(0, (startLine ?? 1) - 1);
        const end = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;
        selectedLines = lines.slice(start, end);
      } else {
        selectedLines = lines;
      }

      const resultContent = selectedLines.join('\n');

      return this.success(`File read successfully: ${filePath}`, {
        content: resultContent,
        totalLines,
        startLine: startLine ?? 1,
        endLine: endLine ?? totalLines,
        size: file.size,
        path: filePath,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[ReadFileExecutor] Error reading file ${filePath}:`, err);
      return this.error(`Failed to read file: ${errorMsg}`);
    }
  }
}
