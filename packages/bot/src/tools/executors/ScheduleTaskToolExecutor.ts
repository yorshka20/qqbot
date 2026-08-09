import { injectable } from 'tsyringe';
import type { AgendaService } from '@/agenda/AgendaService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Read the chain depth for items registered from this execution context:
 * 0 in the reply pipeline; parent depth + 1 inside an agenda run (set by
 * buildAgendaHookContext). AgendaService rejects registrations past the cap.
 */
export function getChainDepth(context: ToolExecutionContext): number {
  return context.hookContext?.metadata.get('agendaChainDepth') ?? 0;
}

@Tool({
  name: 'schedule_task',
  description:
    '给未来的自己安排一次性定时任务：到点后 bot 会以你写下的 prompt 为指令自主执行（可以查资料、发消息）。用于"过一会儿提醒/汇报/跟进"类需求。任务是一次性的，执行后自动删除。',
  executor: 'schedule_task',
  visibility: {
    reply: { sources: ['qq-group', 'qq-private', 'discord'] },
  },
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description:
        '给未来的自己的任务指令。触发时你看不到当前对话，所以要把必要的上下文写进来（例如"提醒群友晚上八点的活动，他们下午讨论过接龙"）。',
    },
    delay_minutes: {
      type: 'number',
      required: false,
      description: '多少分钟后触发（与 trigger_at 二选一）。最短 1 分钟，最长 72 小时。',
    },
    trigger_at: {
      type: 'string',
      required: false,
      description: '触发时间，ISO 8601 格式（与 delay_minutes 二选一）。',
    },
    name: {
      type: 'string',
      required: false,
      description: '任务的简短名称，便于管理。',
    },
  },
  examples: ['五分钟后提醒大家开始点名', '明早九点总结昨晚群里的讨论'],
  whenToUse: '用户要求稍后提醒/跟进，或你自己判断需要在未来某个时间点主动做一件事时调用。',
})
@injectable()
export class ScheduleTaskToolExecutor extends BaseToolExecutor {
  name = 'schedule_task';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const prompt = typeof call.parameters?.prompt === 'string' ? call.parameters.prompt : '';
    const delayMinutes = typeof call.parameters?.delay_minutes === 'number' ? call.parameters.delay_minutes : undefined;
    const triggerAtParam = typeof call.parameters?.trigger_at === 'string' ? call.parameters.trigger_at : undefined;
    const name = typeof call.parameters?.name === 'string' ? call.parameters.name : undefined;

    let triggerAt: string | undefined;
    if (delayMinutes !== undefined) {
      triggerAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    } else if (triggerAtParam) {
      triggerAt = triggerAtParam;
    }
    if (!triggerAt) {
      return this.error('必须提供 delay_minutes 或 trigger_at 之一', 'missing trigger time');
    }

    const agendaService = getContainer().resolve<AgendaService>(DITokens.AGENDA_SERVICE);
    const result = await agendaService.createLlmItem({
      kind: 'once',
      prompt,
      name,
      groupId: context.messageType === 'group' ? context.groupId?.toString() : undefined,
      userId: context.userId.toString(),
      triggerAt,
      chainDepth: getChainDepth(context),
    });

    if (!result.ok) {
      return this.error(`定时任务注册失败：${result.error}`, result.error);
    }
    return this.success(`已安排定时任务「${result.item.name}」，将于 ${result.item.triggerAt} 触发。`, {
      itemId: result.item.id,
      triggerAt: result.item.triggerAt,
    });
  }
}
