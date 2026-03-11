/**
 * Reply-flow skill definitions, usage instructions, and execution.
 * Stateless helpers used by ReplyGenerationService and AIService.
 *
 * v1 skill runtime is backed by TaskManager/TaskExecutor.
 */

import { SkillRegistry, type SkillRegistryOptions } from '@/ai/skills/SkillRegistry';
import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskResult, TaskType } from '@/task/types';
import { logger } from '@/utils/logger';
import type { FunctionCall, ToolDefinition } from '../types';

export interface ReplySkillDefinitionsOptions extends SkillRegistryOptions {}

/**
 * Convert an array of task types to tool definitions (shared by reply flow and SubAgent).
 * Uses SkillRegistry so conversion stays in sync with getReplySkillDefinitions.
 */
export function taskTypesToToolDefinitions(taskTypes: TaskType[]): ToolDefinition[] {
  const registry = new SkillRegistry(taskTypes);
  return registry.toToolDefinitions(registry.getSkillDefinitions());
}

/**
 * Get skill definitions for the reply flow (excludes reply task; excludes search when nativeWebSearchEnabled).
 */
export function getReplySkillDefinitions(
  taskManager: TaskManager,
  options?: ReplySkillDefinitionsOptions,
): ToolDefinition[] {
  const registry = new SkillRegistry(taskManager.getAllTaskTypes());
  const skills = registry.getReplySkills(options);
  return registry.toToolDefinitions(skills);
}

/**
 * Build the skill usage instruction string for prompt injection.
 */
export function buildSkillUsageInstructions(
  taskManager: TaskManager,
  tools: ToolDefinition[],
  options?: ReplySkillDefinitionsOptions,
): string {
  if (tools.length === 0) {
    return options?.nativeWebSearchEnabled
      ? '当前没有本地可用技能；若需要查询公开互联网的最新信息，请直接使用 provider 内建搜索，再基于结果回答。'
      : '当前没有可用技能，请直接回答。';
  }

  const registry = new SkillRegistry(taskManager.getAllTaskTypes());
  const skillDefs = registry.getReplySkills(options);
  const skillsByName = new Map(skillDefs.map((skill) => [skill.name, skill] as const));

  const toolLines = tools.map((tool) => {
    const skill = skillsByName.get(tool.name);
    const required = new Set(tool.parameters.required ?? []);
    const params = Object.entries(tool.parameters.properties ?? {})
      .map(([name, def]) => {
        const requiredLabel = required.has(name) ? '必填' : '可选';
        const enumLabel =
          Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
        return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
      })
      .join('; ');
    const usage = skill?.whenToUse?.trim();
    const examples =
      skill?.examples && skill.examples.length > 0 ? `\n  示例: ${skill.examples.slice(0, 2).join('；')}` : '';
    return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}${examples}`;
  });

  return [
    options?.nativeWebSearchEnabled
      ? '当问题需要公开互联网的最新事实、新闻、网页内容或实时信息时，优先使用 provider 内建搜索；当需要本地文件、memory、RAG 或应用侧数据时，再调用本地技能。'
      : '当问题需要最新事实、网页正文、搜索结果、文件内容，或你缺少关键信息时，先调用技能，再回答；不要凭空假设技能已经执行过。',
    '若当前已有上下文已经足够、只是闲聊、改写、翻译、总结用户已给出的内容，可以不调用技能，直接回答。',
    '优先直接调用最贴近目标的单个技能，尤其是本地 memory、RAG、文件、页面抓取类技能。',
    '技能结果比你自身记忆更可信；如果技能结果与已有印象冲突，以技能结果为准。',
    '如果技能执行失败、返回空结果或信息不足，要诚实说明限制；不要编造结果。',
    '在同一轮中，先解决信息获取，再基于技能结果组织最终回复；不要把"准备去查"当成最终答案。',
    '可用技能列表：',
    ...toolLines,
  ].join('\n');
}

/**
 * Parse skill call arguments JSON. Returns {} on parse error (consistent with ToolRunner.parseArguments).
 */
function parseSkillArguments(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Execute a single skill call: resolve task type and executor, build task and context, run TaskManager.execute.
 * Used as toolExecutor in LLMService.generateWithTools.
 */
export async function executeSkillCall(
  call: FunctionCall,
  context: HookContext,
  taskManager: TaskManager,
  hookManager: HookManager,
): Promise<unknown> {
  logger.info(`[replyTools] Executing skill: ${call.name}`);

  const taskType = taskManager.getTaskType(call.name);
  if (!taskType) {
    throw new Error(`Task type not found for skill: ${call.name}`);
  }
  const executor = taskManager.getExecutor(taskType.executor);
  if (!executor) {
    throw new Error(`Executor not found for skill: ${call.name}`);
  }

  const parameters = parseSkillArguments(call.arguments);
  const task: Task = {
    type: call.name,
    parameters,
    executor: taskType.executor,
  };

  const taskContext = TaskExecutionContextBuilder.fromHookContext(context).withTaskResults(new Map()).build();

  const result: TaskResult = await taskManager.execute(task, taskContext, hookManager, context);

  return result.data ?? result.reply;
}

// Backward-compatible aliases for existing call sites.
export type ReplyToolDefinitionsOptions = ReplySkillDefinitionsOptions;
export const getReplyToolDefinitions = getReplySkillDefinitions;
export const buildToolUsageInstructions = buildSkillUsageInstructions;
export const executeToolCall = executeSkillCall;
