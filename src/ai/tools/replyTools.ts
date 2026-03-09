/**
 * Reply-flow tool definitions, usage instructions, and execution.
 * Stateless helpers used by ReplyGenerationService and AIService instead of ToolUseReplyService.
 */

import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskResult, TaskType } from '@/task/types';
import { logger } from '@/utils/logger';
import type { FunctionCall, ToolDefinition } from '../types';

const REPLY_TASK_NAME = 'reply';
const SEARCH_TASK_NAME = 'search';

export interface ReplyToolDefinitionsOptions {
  nativeWebSearchEnabled?: boolean;
}

/**
 * Get task types available for the reply flow: exclude "reply", and exclude "search" when native web search is enabled.
 */
function getReplyTaskTypes(taskManager: TaskManager, options?: ReplyToolDefinitionsOptions): TaskType[] {
  return taskManager.getAllTaskTypes().filter((tt) => {
    if (tt.name === REPLY_TASK_NAME) {
      return false;
    }
    if (options?.nativeWebSearchEnabled && tt.name === SEARCH_TASK_NAME) {
      return false;
    }
    return true;
  });
}

/**
 * Convert TaskType.parameters to JSON Schema (ToolDefinition.parameters).
 */
function taskParamsToJsonSchema(params: TaskType['parameters']): ToolDefinition['parameters'] {
  const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(params || {})) {
    properties[key] = {
      type: def.type,
      description: def.description || '',
    };
    if (def.required) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * Convert an array of task types to tool definitions (shared by reply flow and SubAgent).
 */
export function taskTypesToToolDefinitions(taskTypes: TaskType[]): ToolDefinition[] {
  return taskTypes.map((tt) => ({
    name: tt.name,
    description: tt.description,
    parameters: taskParamsToJsonSchema(tt.parameters || {}),
  }));
}

/**
 * Get tool definitions for the reply flow (excludes reply task; excludes search when nativeWebSearchEnabled).
 */
export function getReplyToolDefinitions(
  taskManager: TaskManager,
  options?: ReplyToolDefinitionsOptions,
): ToolDefinition[] {
  const taskTypes = getReplyTaskTypes(taskManager, options);
  return taskTypesToToolDefinitions(taskTypes);
}

/**
 * Build the tool usage instruction string for prompt injection (when to use tools, tool list, fallbacks when no tools).
 */
export function buildToolUsageInstructions(
  taskManager: TaskManager,
  tools: ToolDefinition[],
  options?: ReplyToolDefinitionsOptions,
): string {
  if (tools.length === 0) {
    return options?.nativeWebSearchEnabled
      ? '当前没有本地可用工具；若需要查询公开互联网的最新信息，请直接使用 provider 内建搜索，再基于结果回答。'
      : '当前没有可用工具，请直接回答。';
  }

  const taskTypes = getReplyTaskTypes(taskManager, options);
  const taskTypesByName = new Map(taskTypes.map((tt) => [tt.name, tt] as const));

  const toolLines = tools.map((tool) => {
    const taskType = taskTypesByName.get(tool.name);
    const required = new Set(tool.parameters.required ?? []);
    const params = Object.entries(tool.parameters.properties ?? {})
      .map(([name, def]) => {
        const requiredLabel = required.has(name) ? '必填' : '可选';
        const enumLabel =
          Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
        return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
      })
      .join('; ');
    const usage = taskType?.whenToUse?.trim();
    const examples =
      taskType?.examples && taskType.examples.length > 0
        ? `\n  示例: ${taskType.examples.slice(0, 2).join('；')}`
        : '';
    return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}${examples}`;
  });

  return [
    options?.nativeWebSearchEnabled
      ? '当问题需要公开互联网的最新事实、新闻、网页内容或实时信息时，优先使用 provider 内建搜索；当需要本地文件、memory、RAG 或应用侧数据时，再调用本地工具。'
      : '当问题需要最新事实、网页正文、搜索结果、文件内容，或你缺少关键信息时，先调用工具，再回答；不要凭空假设工具已经执行过。',
    '若当前已有上下文已经足够、只是闲聊、改写、翻译、总结用户已给出的内容，可以不调用工具，直接回答。',
    '优先直接调用最贴近目标的单个工具，尤其是本地 memory、RAG、文件、页面抓取类工具。',
    '工具结果比你自身记忆更可信；如果工具结果与已有印象冲突，以工具结果为准。',
    '如果工具执行失败、返回空结果或信息不足，要诚实说明限制；不要编造结果。',
    '在同一轮中，先解决信息获取，再基于工具结果组织最终回复；不要把"准备去查"当成最终答案。',
    '可用工具列表：',
    ...toolLines,
  ].join('\n');
}

/**
 * Execute a single tool call: resolve task type and executor, build task and context, run TaskManager.execute.
 * Used as toolExecutor in LLMService.generateWithTools.
 */
export async function executeToolCall(
  call: FunctionCall,
  context: HookContext,
  taskManager: TaskManager,
  hookManager: HookManager,
): Promise<unknown> {
  logger.info(`[replyTools] Executing tool: ${call.name}`);

  const taskType = taskManager.getTaskType(call.name);
  if (!taskType) {
    throw new Error(`Task type not found for tool: ${call.name}`);
  }
  const executor = taskManager.getExecutor(taskType.executor);
  if (!executor) {
    throw new Error(`Executor not found for tool: ${call.name}`);
  }

  const task: Task = {
    type: call.name,
    parameters: JSON.parse(call.arguments),
    executor: call.name,
  };

  const taskContext = TaskExecutionContextBuilder.fromHookContext(context).withTaskResults(new Map()).build();

  const result: TaskResult = await taskManager.execute(task, taskContext, hookManager, context);

  return result.data ?? result.reply;
}
