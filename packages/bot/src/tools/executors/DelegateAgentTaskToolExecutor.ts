// Hands a long, multi-step task — an investigation or something to build — to a
// local coding-agent CLI (claude / codex / dsh).
// The reply ends right away; the agent's progress and final report arrive in this
// conversation later through CodingAgentService.

import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { CodingAgentService } from '@/services/codingAgent/CodingAgentService';
import { AgentRunOptionsError } from '@/services/codingAgent/runOptions';
import { AGENT_EXECUTOR_NAMES, type AgentExecutorName } from '@/services/codingAgent/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

function isExecutorName(value: unknown): value is AgentExecutorName {
  return typeof value === 'string' && (AGENT_EXECUTOR_NAMES as readonly string[]).includes(value);
}

@Tool({
  name: 'delegate_agent_task',
  description:
    '把一个需要长时间、多步骤完成的任务交给本地 agent（claude / codex / dsh）异步执行：深度调研，或做出一个东西（网页、脚本、文档、数据）。agent 在独立工作区里运行，能联网搜索、抓取网页、写代码并实际运行验证，产物可以作为文件发回，耗时几分钟到几十分钟。调用后立即返回；agent 的进度、汇报和文件会自动发到当前会话，不需要你等待或转述。',
  whenToUse:
    '只用于你自己和 research 工具做不了的重任务：需要多来源综合对比的调研、需要跑代码或实验验证、需要产出完整报告或文件（网页、脚本、文档等）。简单查询、单个网页、几句话能答的问题用 research 或直接回答。调用后用一句话告诉对方已经安排、大概要多久，然后结束本次回复，不要自己去完成这个任务。',
  examples: [
    '深入对比三个开源向量数据库的性能、许可证和社区活跃度，给出选型建议',
    '调研某个库最近半年的重大变更，跑一下示例代码确认新 API 的用法',
    '做一个展示周末活动建议的单页网页，打包发过来',
  ],
  executor: 'delegate_agent_task',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true } },
  // container-lookup: optional-service CodingAgentService is only registered when codingAgent.enabled is true
  available: () => getContainer().isRegistered(DITokens.CODING_AGENT_SERVICE),
  parameters: {
    task: {
      type: 'string',
      required: true,
      description:
        '完整、自包含的任务描述。agent 看不到当前聊天，要把问题本身、相关背景（对话里提到的条件、偏好、已知信息）、期望的交付形式都写进来。',
    },
    executor: {
      type: 'string',
      required: false,
      enum: [...AGENT_EXECUTOR_NAMES],
      description: '执行的 agent。不填则用默认的。',
    },
    model: {
      type: 'string',
      required: false,
      description: '模型 ID。一般不填，用默认模型；用户明确要求时才填。',
    },
    effort: {
      type: 'string',
      required: false,
      description: '推理强度（如 low / medium / high）。一般不填；用户明确要求时才填。',
    },
  },
})
@injectable()
export class DelegateAgentTaskToolExecutor extends BaseToolExecutor {
  name = 'delegate_agent_task';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const task = typeof call.parameters?.task === 'string' ? call.parameters.task.trim() : '';
    if (!task) {
      return this.error('task 不能为空，需要写明完整的任务', 'missing task');
    }
    const executorParam = call.parameters?.executor;
    if (executorParam !== undefined && !isExecutorName(executorParam)) {
      return this.error(`executor 只能是 ${AGENT_EXECUTOR_NAMES.join(' / ')}`, 'invalid executor');
    }
    const model = typeof call.parameters?.model === 'string' ? call.parameters.model : undefined;
    const effort = typeof call.parameters?.effort === 'string' ? call.parameters.effort : undefined;

    // container-lookup: optional-service CodingAgentService is only registered when codingAgent.enabled is true
    const container = getContainer();
    if (!container.isRegistered(DITokens.CODING_AGENT_SERVICE)) {
      return this.error('本地 agent 服务未启用', 'coding agent service not available');
    }
    const service = container.resolve<CodingAgentService>(DITokens.CODING_AGENT_SERVICE);

    const isGroup = context.messageType === 'group' && context.groupId != null;
    try {
      const created = await service.triggerTask(
        task,
        {
          type: isGroup ? 'group' : 'user',
          id: String(isGroup ? context.groupId : context.userId),
          userId: String(context.userId),
          messageId: context.messageId,
        },
        undefined,
        { executor: executorParam, run: { model, effort }, taskType: 'workspace' },
      );
      const agentName = service.getExecutor(created.executor).displayName;
      const queued = created.queuePosition > 0 ? `，前面还有 ${created.queuePosition} 个任务在排队` : '';
      return this.success(
        `已交给 ${agentName}（任务 ${created.id.slice(0, 8)}，模型 ${created.model}${queued}）。进度和最终汇报会自动发到当前会话，你不需要等待，也不要自己去完成这个任务；用一句话告诉对方已经安排、大概需要几分钟到几十分钟即可。`,
        { taskId: created.id, executor: created.executor, queuePosition: created.queuePosition },
      );
    } catch (error) {
      if (error instanceof AgentRunOptionsError) {
        return this.error(`参数不对，任务未派发：${error.message}`, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[DelegateAgentTaskToolExecutor] Failed to delegate task:', error);
      return this.error(`派发失败：${message}`, message);
    }
  }
}
