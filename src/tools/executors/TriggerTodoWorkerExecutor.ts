// TriggerTodoWorkerExecutor - triggers a Claude Code task to complete todo.md items in a project
//
// Resolves the target project from ProjectRegistry, then spawns a Claude Code
// task with the todo-worker prompt template.  The task runs asynchronously;
// results are delivered to the requester via ClaudeCodeService.handleTaskUpdate.

import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import type { ProjectContext } from '@/services/mcpServer/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'trigger_todo_worker',
  description:
    '触发 Claude Code 在指定项目中执行 todo.md 里的待办任务。Claude Code 会阅读 todo.md、完成至少一项任务、标记为完成，并汇报结果。',
  executor: 'trigger_todo_worker',
  visibility: ['subagent'],
  parameters: {
    project: {
      type: 'string',
      required: true,
      description: '项目别名（已在 ProjectRegistry 中注册的 alias）',
    },
  },
  whenToUse: '当需要自动完成某个项目 todo.md 中的待办任务时使用。需要提供已注册的项目别名。',
})
@injectable()
export class TriggerTodoWorkerExecutor extends BaseToolExecutor {
  name = 'trigger_todo_worker';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const projectAlias = call.parameters?.project as string | undefined;

    if (!projectAlias) {
      return this.error('请提供项目别名', 'Missing required parameter: project');
    }

    // Resolve ClaudeCodeService from DI (may not be available)
    let claudeCodeService: ClaudeCodeService;
    try {
      const container = getContainer();
      claudeCodeService = container.resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
    } catch {
      return this.error('Claude Code 服务未启用', 'ClaudeCodeService not available');
    }

    // Resolve project from registry
    const registry = claudeCodeService.getProjectRegistry();
    if (!registry) {
      return this.error('项目注册表未配置', 'ProjectRegistry not configured');
    }

    const project = registry.resolve(projectAlias);
    if (!project) {
      logger.warn(`[TriggerTodoWorkerExecutor] Project not found: ${projectAlias}`);
      return this.error(
        `未找到项目: ${projectAlias}`,
        `Project "${projectAlias}" not found in registry`,
      );
    }

    // Build project context with todo-worker prompt template override
    const projectContext: ProjectContext = {
      alias: project.alias,
      type: project.type,
      description: project.description,
      hasClaudeMd: project.hasClaudeMd,
      promptTemplateKey: 'claude-code.task.todo-worker',
    };

    // Determine request target from execution context
    const targetType = context.groupId ? 'group' : 'user';
    const targetId = context.groupId ? String(context.groupId) : String(context.userId);

    try {
      const task = await claudeCodeService.triggerTask(
        `阅读并完成 ${project.alias} 项目 todo.md 中的待办任务`,
        { type: targetType, id: targetId },
        project.path,
        { taskType: 'dev', projectContext },
      );

      const queueMsg =
        task.queuePosition > 0 ? `（排队位置: 第${task.queuePosition}位）` : '';

      logger.info(
        `[TriggerTodoWorkerExecutor] Todo worker task created: ${task.id} for project "${project.alias}"${queueMsg}`,
      );

      return this.success(
        `已触发 todo-worker 任务 (${task.id.slice(0, 8)})，项目: ${project.alias}${queueMsg}。任务完成后会自动发送结果。`,
        {
          taskId: task.id,
          project: project.alias,
          workingDirectory: project.path,
          queuePosition: task.queuePosition,
        },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TriggerTodoWorkerExecutor] Failed to trigger task:`, error);
      return this.error(`触发任务失败: ${errorMsg}`, errorMsg);
    }
  }
}
