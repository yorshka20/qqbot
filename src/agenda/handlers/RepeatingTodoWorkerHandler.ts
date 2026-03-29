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

interface RoundResult {
  round: number;
  status: 'completed' | 'failed';
  error?: string;
}

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

    const targetType: 'group' | 'user' = ctx.groupId ? 'group' : 'user';
    const targetId = ctx.groupId ?? ctx.userId ?? '';

    const startTime = Date.now();

    logger.info(
      `${TAG} Starting repeating session: project="${project.alias}", repeat=${repeat}, interval=${intervalMinutes}min`,
    );

    const projectContext: ProjectContext = {
      alias: project.alias,
      type: project.type,
      description: project.description,
      hasClaudeMd: project.hasClaudeMd,
      promptTemplateKey: 'claude-code.task.todo-worker',
    };

    // Schedule all rounds at fixed intervals (T=0, T=interval, T=2*interval, ...)
    // Each round triggers independently — if a previous task hasn't finished,
    // the new one enters the queue and will execute when ready.
    const taskPromises = Array.from({ length: repeat }, (_, i) => {
      const round = i + 1;
      const delayMs = i * intervalMinutes * 60 * 1000;

      return this.scheduleRound({
        round,
        repeat,
        delayMs,
        claudeCodeService,
        projectContext,
        projectPath: project.path,
        projectAlias: project.alias,
        prompt: `完成 ${project.alias} 项目 todo.md 中的待办任务`,
        target: { type: targetType, id: targetId },
      });
    });

    // Wait for all rounds to complete
    const results = await Promise.all(taskPromises);

    // Build brief summary — individual results are reported by each worker's own notification
    const elapsedMin = Math.round((Date.now() - startTime) / 1000 / 60);
    const completed = results.filter((r) => r.status === 'completed').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    const lines: string[] = [
      `📋 自动开发会话完成 — 项目: ${project.alias}`,
      `共执行 ${repeat} 轮，✅ 成功 ${completed}，❌ 失败 ${failed}，总耗时 ${elapsedMin} 分钟`,
    ];

    if (failed > 0) {
      for (const r of results) {
        if (r.status === 'failed') {
          lines.push(`  第 ${r.round} 轮失败: ${r.error}`);
        }
      }
    }

    return lines.join('\n');
  }

  private scheduleRound(opts: {
    round: number;
    repeat: number;
    delayMs: number;
    claudeCodeService: ClaudeCodeService;
    projectContext: ProjectContext;
    projectPath: string;
    projectAlias: string;
    prompt: string;
    target: { type: 'group' | 'user'; id: string };
  }): Promise<RoundResult> {
    const { round, repeat, delayMs, claudeCodeService, projectContext, projectPath, prompt, target } = opts;

    return new Promise<RoundResult>((resolve) => {
      setTimeout(async () => {
        logger.info(`${TAG} Triggering round ${round}/${repeat} for project "${opts.projectAlias}"`);
        try {
          const task = await claudeCodeService.triggerTask(prompt, target, projectPath, {
            taskType: 'dev',
            projectContext,
          });

          logger.info(`${TAG} Round ${round}/${repeat}: task ${task.id} created, waiting for completion...`);
          const completedTask = await claudeCodeService.awaitTaskCompletion(task.id);
          const status = (completedTask.status as 'completed' | 'failed') ?? 'failed';

          logger.info(`${TAG} Round ${round}/${repeat}: ${status}`);
          resolve({ round, status, error: status === 'failed' ? completedTask.error || '未知错误' : undefined });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`${TAG} Round ${round}/${repeat} failed:`, error);
          resolve({ round, status: 'failed', error: msg });
        }
      }, delayMs);
    });
  }

  private parseParams(raw?: string): RepeatingParams {
    if (!raw) return { project: '' };
    try {
      return JSON.parse(raw) as RepeatingParams;
    } catch {
      return { project: '' };
    }
  }
}
