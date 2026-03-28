// RepeatingTodoWorkerHandler - triggers Claude Code CLI to complete todo.md tasks
// multiple times with a configurable interval. Designed for cron-based daily
// automated development sessions (e.g., 5 runs at 30-minute intervals starting at 2 AM).

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import type { ProjectContext } from '@/services/mcpServer/types';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

const TAG = '[RepeatingTodoWorkerHandler]';

interface RepeatingParams {
  project: string;
  /** Number of times to trigger the todo worker (default: 5) */
  repeat?: number;
  /** Interval in minutes between triggers (default: 30) */
  intervalMinutes?: number;
}

export class RepeatingTodoWorkerHandler implements ActionHandler {
  readonly name = 'repeating_todo_worker';

  async execute(ctx: ActionHandlerContext): Promise<string | void> {
    const params = this.parseParams(ctx.item.actionParams);

    if (!params.project) {
      logger.error(`${TAG} Missing "project" in actionParams`);
      return '❌ repeating_todo_worker: 缺少 project 参数';
    }

    const repeat = params.repeat ?? 5;
    const intervalMinutes = params.intervalMinutes ?? 30;

    let claudeCodeService: ClaudeCodeService;
    try {
      claudeCodeService = getContainer().resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
    } catch {
      logger.error(`${TAG} ClaudeCodeService not available`);
      return '❌ repeating_todo_worker: Claude Code 服务未启用';
    }

    const registry = claudeCodeService.getProjectRegistry();
    if (!registry) {
      return '❌ repeating_todo_worker: 项目注册表未配置';
    }

    const project = registry.resolve(params.project);
    if (!project) {
      return `❌ repeating_todo_worker: 未找到项目 "${params.project}"`;
    }

    const targetType = ctx.groupId ? 'group' : 'user';
    const targetId = ctx.groupId ?? ctx.userId ?? '';

    logger.info(
      `${TAG} Starting repeating session: project="${project.alias}", repeat=${repeat}, interval=${intervalMinutes}min`,
    );

    const results: Array<{ round: number; status: 'completed' | 'failed'; summary: string }> = [];

    for (let i = 1; i <= repeat; i++) {
      // Wait interval before each trigger (except the first)
      if (i > 1) {
        logger.info(`${TAG} Waiting ${intervalMinutes} minutes before round ${i}/${repeat}...`);
        await this.delay(intervalMinutes * 60 * 1000);
      }

      logger.info(`${TAG} Triggering round ${i}/${repeat} for project "${project.alias}"`);

      const projectContext: ProjectContext = {
        alias: project.alias,
        type: project.type,
        description: project.description,
        hasClaudeMd: project.hasClaudeMd,
        promptTemplateKey: 'claude-code.task.todo-worker',
      };

      try {
        const task = await claudeCodeService.triggerTask(
          `阅读并完成 ${project.alias} 项目 todo.md 中的待办任务`,
          { type: targetType, id: targetId },
          project.path,
          { taskType: 'dev', projectContext, suppressDefaultNotification: true },
        );

        logger.info(`${TAG} Round ${i}/${repeat}: task ${task.id} created, waiting for completion...`);

        // Wait for this task to finish
        const completedTask = await claudeCodeService.awaitTaskCompletion(task.id);

        const status = completedTask.status as 'completed' | 'failed';
        const summary =
          status === 'completed'
            ? this.truncate(completedTask.result || '无结果', 500)
            : this.truncate(completedTask.error || '未知错误', 500);

        results.push({ round: i, status, summary });

        logger.info(`${TAG} Round ${i}/${repeat}: ${status}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`${TAG} Round ${i}/${repeat} failed:`, error);
        results.push({ round: i, status: 'failed', summary: msg });
      }
    }

    // Build final summary
    const completed = results.filter((r) => r.status === 'completed').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    const lines: string[] = [
      `📋 自动开发会话完成 — 项目: ${project.alias}`,
      `✅ 成功: ${completed}/${repeat}　❌ 失败: ${failed}/${repeat}`,
      '',
    ];

    for (const r of results) {
      const icon = r.status === 'completed' ? '✅' : '❌';
      lines.push(`${icon} 第 ${r.round} 轮: ${r.summary}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseParams(raw?: string): RepeatingParams {
    if (!raw) return { project: '' };
    try {
      return JSON.parse(raw) as RepeatingParams;
    } catch {
      return { project: '' };
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 10)}...(截断)`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
