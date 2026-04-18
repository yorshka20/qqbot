// GitPRExecutor - creates GitHub Pull Requests via gh CLI

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

export class GitPRExecutor extends BaseToolExecutor {
  name = 'git_create_pr';

  definition: ToolDefinition = {
    name: 'git_create_pr',
    description: '创建 GitHub Pull Request。自动生成规范的 PR 标题和描述。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'PR 标题。',
      },
      body: {
        type: 'string',
        required: false,
        description: 'PR 描述。不指定则根据 commits 自动生成。',
      },
      base: {
        type: 'string',
        required: false,
        description: '目标分支。默认 main 或 master。',
      },
      draft: {
        type: 'boolean',
        required: false,
        description: '是否创建为 draft PR。默认 false。',
      },
      labels: {
        type: 'array',
        required: false,
        description: 'PR 标签列表。',
      },
      reviewers: {
        type: 'array',
        required: false,
        description: '请求 review 的用户列表。',
      },
    },
    examples: [
      'git_create_pr title="feat: add user authentication"',
      'git_create_pr title="fix: memory leak" labels=["bug", "priority-high"]',
    ],
    whenToUse: '当代码完成并通过测试，需要创建 PR 合并到主分支时使用。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const title = parameters.title as string;
    const body = parameters.body as string | undefined;
    const base = parameters.base as string | undefined;
    const draft = (parameters.draft as boolean | undefined) ?? false;
    const labels = parameters.labels as string[] | undefined;
    const reviewers = parameters.reviewers as string[] | undefined;

    if (!title) {
      return this.error('Missing required parameter: title');
    }

    logger.info(`[GitPRExecutor] Creating PR: ${title}`);

    // Push current branch first
    const pushResult = await this.pushBranch();
    if (!pushResult.success) {
      return this.error(`Failed to push branch: ${pushResult.error}`);
    }

    // Generate PR body if not provided
    const prBody = body ?? (await this.generatePRBody());

    // Build gh pr create command
    const cmd = ['gh', 'pr', 'create', '--title', title, '--body', prBody];

    if (base) {
      cmd.push('--base', base);
    }
    if (draft) {
      cmd.push('--draft');
    }
    if (labels && labels.length > 0) {
      cmd.push('--label', labels.join(','));
    }
    if (reviewers && reviewers.length > 0) {
      cmd.push('--reviewer', reviewers.join(','));
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
      return this.error(`Failed to create PR: ${stderr.trim()}`);
    }

    const prUrl = stdout.trim();
    logger.info(`[GitPRExecutor] PR created: ${prUrl}`);

    return this.success(`Pull Request created: ${prUrl}`, {
      url: prUrl,
      title,
      draft,
      base: base ?? 'default',
    });
  }

  private async pushBranch(): Promise<{ success: boolean; error?: string }> {
    // Get current branch name
    const branchProc = spawn({
      cmd: ['git', 'branch', '--show-current'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await branchProc.exited;
    const branch = (await new Response(branchProc.stdout).text()).trim();

    if (!branch) {
      return { success: false, error: 'Could not determine current branch' };
    }

    // Push with upstream tracking
    const proc = spawn({
      cmd: ['git', 'push', '-u', 'origin', branch],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      // Ignore "already up to date" type messages
      if (stderr.includes('Everything up-to-date') || stderr.includes('up to date')) {
        return { success: true };
      }
      return { success: false, error: stderr.trim() };
    }

    return { success: true };
  }

  private async generatePRBody(): Promise<string> {
    // Get recent commits for summary
    const proc = spawn({
      cmd: ['git', 'log', '--oneline', '-10', 'origin/HEAD..HEAD'],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const commits = (await new Response(proc.stdout).text()).trim();

    const lines = [
      '## Summary',
      '',
      commits
        ? commits
            .split('\n')
            .map((c) => `- ${c.slice(8)}`)
            .join('\n')
        : '- Changes as described in the title',
      '',
      '## Test Plan',
      '',
      '- [ ] Code reviewed',
      '- [ ] Tests pass',
      '- [ ] Lint passes',
      '',
      '🤖 Generated with Claude Code',
    ];

    return lines.join('\n');
  }
}
