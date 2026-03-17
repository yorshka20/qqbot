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
import type { PromptManager } from '@/ai/prompt/PromptManager';
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
 * Renders from prompt templates via PromptManager.
 */
export function buildSkillUsageInstructions(
  taskManager: TaskManager,
  tools: ToolDefinition[],
  options: ReplySkillDefinitionsOptions | undefined,
  promptManager: PromptManager,
): string {
  if (tools.length === 0) {
    return promptManager.render(
      options?.nativeWebSearchEnabled ? 'llm.tool.no_tools.native_search' : 'llm.tool.no_tools.local',
    );
  }

  const registry = new SkillRegistry(taskManager.getAllTaskTypes());
  const skillDefs = registry.getReplySkills(options);
  const skillsByName = new Map(skillDefs.map((skill) => [skill.name, skill] as const));

  const toolList = tools
    .map((tool) => {
      const skill = skillsByName.get(tool.name);
      const required = new Set(tool.parameters.required ?? []);
      const params = Object.entries(tool.parameters.properties ?? {})
        .map(([name, def]) => {
          const requiredLabel = required.has(name) ? '必填' : '可选';
          const enumLabel = Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
          return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
        })
        .join('; ');
      const usage = skill?.whenToUse?.trim();
      const examples =
        skill?.examples && skill.examples.length > 0 ? `\n  示例: ${skill.examples.slice(0, 2).join('；')}` : '';
      return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}${examples}`;
    })
    .join('\n');

  const nativeSearchNote = promptManager.render(
    options?.nativeWebSearchEnabled ? 'llm.tool.note.native_search' : 'llm.tool.note.local',
  );

  return promptManager.render('llm.tool.usage', { nativeSearchNote, toolList });
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
