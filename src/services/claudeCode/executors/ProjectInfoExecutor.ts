// ProjectInfoExecutor - queries project structure, dependencies, and git status

import * as path from 'node:path';
import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

export class ProjectInfoExecutor extends BaseToolExecutor {
  name = 'project_info';

  definition: ToolDefinition = {
    name: 'project_info',
    description: '获取项目结构和信息。用于了解项目布局、依赖和最近变更。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '查询类型: structure/dependencies/recent-changes/git-status/git-log',
        enum: ['structure', 'dependencies', 'recent-changes', 'git-status', 'git-log'],
      },
      path: {
        type: 'string',
        required: false,
        description: '指定路径。structure 时用于限定目录。',
      },
      depth: {
        type: 'number',
        required: false,
        description: '目录深度。structure 时有效。默认 3。',
      },
      limit: {
        type: 'number',
        required: false,
        description: '结果数量限制。recent-changes/git-log 时有效。默认 10。',
      },
    },
    examples: [
      'project_info query="structure" path="src/services"',
      'project_info query="dependencies"',
      'project_info query="git-status"',
      'project_info query="git-log" limit=5',
    ],
    whenToUse: '当需要了解项目结构、查看依赖或检查最近变更时使用。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const query = parameters.query as string;

    if (!query) {
      return this.error('Missing required parameter: query');
    }

    logger.debug(`[ProjectInfoExecutor] Query: ${query}`);

    switch (query) {
      case 'structure':
        return this.getStructure(
          (parameters.path as string | undefined) ?? '.',
          (parameters.depth as number | undefined) ?? 3,
        );
      case 'dependencies':
        return this.getDependencies();
      case 'recent-changes':
        return this.getRecentChanges((parameters.limit as number | undefined) ?? 10);
      case 'git-status':
        return this.getGitStatus();
      case 'git-log':
        return this.getGitLog((parameters.limit as number | undefined) ?? 10);
      default:
        return this.error(
          `Unknown query type: ${query}. Valid types: structure, dependencies, recent-changes, git-status, git-log`,
        );
    }
  }

  private async getStructure(dirPath: string, depth: number): Promise<ToolExecuteResult> {
    // Security: resolve and verify the path stays within the working directory
    const resolvedPath = path.resolve(this.workingDirectory, dirPath);
    if (!resolvedPath.startsWith(this.workingDirectory)) {
      return this.error(`Path is outside the project directory: ${dirPath}`);
    }

    const proc = spawn({
      cmd: [
        'find',
        resolvedPath,
        '-maxdepth',
        String(depth),
        '-not',
        '-path',
        '*/node_modules/*',
        '-not',
        '-path',
        '*/.git/*',
      ],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to get structure: ${stderr}`);
    }

    const entries = output.trim().split('\n').filter(Boolean);
    return this.success(`Directory structure for: ${dirPath}`, { structure: entries, count: entries.length });
  }

  private async getDependencies(): Promise<ToolExecuteResult> {
    try {
      const pkgFile = Bun.file(path.join(this.workingDirectory, 'package.json'));
      const exists = await pkgFile.exists();
      if (!exists) {
        return this.error('package.json not found');
      }

      const pkg = (await pkgFile.json()) as Record<string, unknown>;
      return this.success('Dependencies retrieved', {
        name: pkg.name,
        version: pkg.version,
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
        scripts: pkg.scripts ?? {},
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.error(`Failed to read package.json: ${errorMsg}`);
    }
  }

  private async getRecentChanges(limit: number): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'diff', '--stat', `HEAD~${limit}`],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to get recent changes: ${stderr}`);
    }

    return this.success(`Recent changes (last ${limit} commits)`, { diff: output.trim() });
  }

  private async getGitStatus(): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'status', '--porcelain'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to get git status: ${stderr}`);
    }

    const lines = output.trim().split('\n').filter(Boolean);
    const files = lines.map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }));

    return this.success('Git status retrieved', { files, count: files.length, raw: output.trim() });
  }

  private async getGitLog(limit: number): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'log', '--oneline', `-${limit}`],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to get git log: ${stderr}`);
    }

    const commits = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        hash: line.slice(0, 7),
        message: line.slice(8),
      }));

    return this.success(`Git log (last ${limit} commits)`, { commits });
  }
}
