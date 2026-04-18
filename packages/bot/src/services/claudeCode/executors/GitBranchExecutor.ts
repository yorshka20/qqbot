// GitBranchExecutor - manages git branches (create, switch, list, delete, merge)

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

type BranchAction = 'create' | 'switch' | 'list' | 'delete' | 'merge';

export class GitBranchExecutor extends BaseToolExecutor {
  name = 'git_branch';

  definition: ToolDefinition = {
    name: 'git_branch',
    description: 'Git 分支管理。创建、切换、列出或删除分支。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '操作类型: create/switch/list/delete/merge',
        enum: ['create', 'switch', 'list', 'delete', 'merge'],
      },
      name: {
        type: 'string',
        required: false,
        description: '分支名称。create/switch/delete/merge 时必填。',
      },
      from: {
        type: 'string',
        required: false,
        description: '基于哪个分支创建。仅 create 时有效。默认当前分支。',
      },
      force: {
        type: 'boolean',
        required: false,
        description: '是否强制操作。用于 delete 未合并的分支。',
      },
    },
    examples: [
      'git_branch action="create" name="feat/user-auth"',
      'git_branch action="switch" name="main"',
      'git_branch action="list"',
      'git_branch action="merge" name="feat/user-auth"',
    ],
    whenToUse: '当需要创建新功能分支、切换分支或合并分支时使用。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const action = parameters.action as BranchAction;
    const name = parameters.name as string | undefined;
    const from = parameters.from as string | undefined;
    const force = (parameters.force as boolean | undefined) ?? false;

    if (!action) {
      return this.error('Missing required parameter: action');
    }

    if (action !== 'list' && !name) {
      return this.error(`Parameter "name" is required for action: ${action}`);
    }

    logger.info(`[GitBranchExecutor] Action: ${action} name: ${name ?? 'N/A'}`);

    // name is guaranteed by the check above for all actions except 'list'
    const branchName = name ?? '';

    switch (action) {
      case 'create':
        return this.createBranch(branchName, from);
      case 'switch':
        return this.switchBranch(branchName);
      case 'list':
        return this.listBranches();
      case 'delete':
        return this.deleteBranch(branchName, force);
      case 'merge':
        return this.mergeBranch(branchName);
      default:
        return this.error(`Unknown action: ${action}`);
    }
  }

  private async createBranch(name: string, from?: string): Promise<ToolExecuteResult> {
    const cmd = from ? ['git', 'checkout', '-b', name, from] : ['git', 'checkout', '-b', name];

    const proc = spawn({ cmd, cwd: this.workingDirectory, stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to create branch: ${stderr.trim()}`);
    }

    return this.success(`Branch created and switched to: ${name}`, { branch: name, from: from ?? 'current' });
  }

  private async switchBranch(name: string): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'checkout', name],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to switch branch: ${stderr.trim()}`);
    }

    return this.success(`Switched to branch: ${name}`, { branch: name });
  }

  private async listBranches(): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'branch', '-a'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to list branches: ${stderr.trim()}`);
    }

    const branches = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const isCurrent = line.startsWith('*');
        return {
          name: line.replace(/^\*?\s+/, '').trim(),
          current: isCurrent,
        };
      });

    const current = branches.find((b) => b.current)?.name ?? 'unknown';
    return this.success(`${branches.length} branches found`, { branches, current });
  }

  private async deleteBranch(name: string, force: boolean): Promise<ToolExecuteResult> {
    const cmd = force ? ['git', 'branch', '-D', name] : ['git', 'branch', '-d', name];

    const proc = spawn({ cmd, cwd: this.workingDirectory, stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to delete branch: ${stderr.trim()}`);
    }

    return this.success(`Branch deleted: ${name}`, { branch: name, output: stdout.trim() });
  }

  private async mergeBranch(name: string): Promise<ToolExecuteResult> {
    const proc = spawn({
      cmd: ['git', 'merge', name],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return this.error(`Failed to merge branch: ${stderr.trim()}`, stdout.trim());
    }

    return this.success(`Merged branch: ${name}`, { branch: name, output: stdout.trim() });
  }
}
