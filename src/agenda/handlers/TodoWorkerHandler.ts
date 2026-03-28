// TodoWorkerHandler - directly triggers Claude Code CLI to complete todo.md tasks
// in a specified project. No LLM involved — resolves project from registry and
// calls ClaudeCodeService.triggerTask() immediately.

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import type { ProjectContext } from '@/services/mcpServer/types';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

export class TodoWorkerHandler implements ActionHandler {
  readonly name = 'todo_worker';

  async execute(ctx: ActionHandlerContext): Promise<string | void> {
    const params = this.parseParams(ctx.item.actionParams);
    const projectAlias = params.project as string | undefined;

    if (!projectAlias) {
      logger.error('[TodoWorkerHandler] Missing "project" in actionParams');
      return '❌ todo_worker: 缺少 project 参数';
    }

    let claudeCodeService: ClaudeCodeService;
    try {
      claudeCodeService = getContainer().resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
    } catch {
      logger.error('[TodoWorkerHandler] ClaudeCodeService not available');
      return '❌ todo_worker: Claude Code 服务未启用';
    }

    const registry = claudeCodeService.getProjectRegistry();
    if (!registry) {
      return '❌ todo_worker: 项目注册表未配置';
    }

    const project = registry.resolve(projectAlias);
    if (!project) {
      logger.warn(`[TodoWorkerHandler] Project not found: ${projectAlias}`);
      return `❌ todo_worker: 未找到项目 "${projectAlias}"`;
    }

    const projectContext: ProjectContext = {
      alias: project.alias,
      type: project.type,
      description: project.description,
      hasClaudeMd: project.hasClaudeMd,
      promptTemplateKey: 'claude-code.task.todo-worker',
    };

    const targetType = ctx.groupId ? 'group' : 'user';
    const targetId = ctx.groupId ?? ctx.userId ?? '';

    try {
      const task = await claudeCodeService.triggerTask(
        `阅读并完成 ${project.alias} 项目 todo.md 中的待办任务`,
        { type: targetType, id: targetId },
        project.path,
        { taskType: 'dev', projectContext },
      );

      const queueMsg = task.queuePosition > 0 ? `（排队: 第${task.queuePosition}位）` : '';
      logger.info(
        `[TodoWorkerHandler] Task created: ${task.id} for project "${project.alias}"${queueMsg}`,
      );

      // No reply — result will be delivered async via handleTaskUpdate
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[TodoWorkerHandler] Failed to trigger task:', error);
      return `❌ todo_worker 触发失败: ${msg}`;
    }
  }

  private parseParams(raw?: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
