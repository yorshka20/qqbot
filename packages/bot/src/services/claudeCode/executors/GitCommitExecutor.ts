// GitCommitExecutor - creates git commits following project conventions

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

const VALID_TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'style', 'perf', 'ci', 'build', 'revert'];
const CO_AUTHOR = 'Claude <noreply@anthropic.com>';

export class GitCommitExecutor extends BaseToolExecutor {
  name = 'git_commit';

  definition: ToolDefinition = {
    name: 'git_commit',
    description: '按照项目规范创建 Git 提交。自动格式化 commit message，添加 Co-Author。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '提交信息。格式: <type>: <description>。type 可选: feat/fix/docs/refactor/test/chore',
      },
      files: {
        type: 'array',
        required: false,
        description: '要提交的文件列表。不指定则提交所有已修改文件。',
      },
      scope: {
        type: 'string',
        required: false,
        description: '影响范围，如 api、ui。会添加到 type 后面。',
      },
      body: {
        type: 'string',
        required: false,
        description: '详细描述（commit body）。',
      },
      skipHooks: {
        type: 'boolean',
        required: false,
        description: '是否跳过 git hooks。默认 false。',
      },
    },
    examples: [
      'git_commit message="feat: add user authentication"',
      'git_commit message="fix: resolve memory leak" scope="api"',
      'git_commit message="refactor: simplify login flow" body="Reduced code complexity by 30%"',
    ],
    whenToUse: '当需要提交代码变更时使用。确保遵循项目的 commit 规范。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const message = parameters.message as string;
    const files = parameters.files as string[] | undefined;
    const scope = parameters.scope as string | undefined;
    const body = parameters.body as string | undefined;
    const skipHooks = (parameters.skipHooks as boolean | undefined) ?? false;

    if (!message) {
      return this.error('Missing required parameter: message');
    }

    // Parse and validate message format
    const commitMessage = this.buildCommitMessage(message, scope, body);
    if (!commitMessage.valid || !commitMessage.full) {
      return this.error(commitMessage.error ?? 'Failed to build commit message');
    }

    const fullMessage = commitMessage.full;
    logger.info(`[GitCommitExecutor] Committing with message: ${fullMessage.split('\n')[0]}`);

    // Stage files
    const stageResult = await this.stageFiles(files);
    if (!stageResult.success) {
      return this.error(stageResult.error ?? 'Failed to stage files');
    }

    // Check if there's anything to commit
    const statusCheck = spawn({
      cmd: ['git', 'status', '--porcelain'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const statusOutput = await new Response(statusCheck.stdout).text();
    if (!statusOutput.trim()) {
      return this.error('Nothing to commit. Working tree clean.');
    }

    // Execute commit
    const cmd = ['git', 'commit', '-m', fullMessage];
    if (skipHooks) {
      cmd.push('--no-verify');
    }

    const proc = spawn({
      cmd,
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Git commit failed: ${stderr}`);
    }

    // Get commit hash
    const hashProc = spawn({
      cmd: ['git', 'rev-parse', '--short', 'HEAD'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await hashProc.exited;
    const hash = (await new Response(hashProc.stdout).text()).trim();

    logger.info(`[GitCommitExecutor] Committed: ${hash}`);

    return this.success(`Commit created: ${hash}`, {
      hash,
      message: fullMessage.split('\n')[0],
      output: stdout.trim(),
    });
  }

  private buildCommitMessage(
    message: string,
    scope?: string,
    body?: string,
  ): { valid: boolean; full?: string; error?: string } {
    // Check if message already has type prefix
    const typePattern = /^(\w+)(\([^)]+\))?:\s+.+/;
    let finalMessage: string;

    if (typePattern.test(message)) {
      // Message already has type - use as-is but validate type
      const typeMatch = message.match(/^(\w+)/);
      const type = typeMatch?.[1];
      if (type && !VALID_TYPES.includes(type)) {
        return {
          valid: false,
          error: `Invalid commit type: "${type}". Valid types: ${VALID_TYPES.join(', ')}`,
        };
      }
      // If scope provided, inject it
      if (scope) {
        finalMessage = message.replace(/^(\w+)(\([^)]+\))?:/, `$1(${scope}):`);
      } else {
        finalMessage = message;
      }
    } else {
      // No type prefix - treat as description, default to 'chore'
      finalMessage = `chore${scope ? `(${scope})` : ''}: ${message}`;
    }

    // Build full commit message with body and co-author
    const parts = [finalMessage];
    if (body) {
      parts.push('', body);
    }
    parts.push('', `Co-Authored-By: ${CO_AUTHOR}`);

    return { valid: true, full: parts.join('\n') };
  }

  private async stageFiles(files?: string[]): Promise<{ success: boolean; error?: string }> {
    const cmd = files && files.length > 0 ? ['git', 'add', ...files] : ['git', 'add', '-A'];

    const proc = spawn({
      cmd,
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { success: false, error: `Failed to stage files: ${stderr}` };
    }

    return { success: true };
  }
}
