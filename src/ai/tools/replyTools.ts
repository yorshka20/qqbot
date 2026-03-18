/**
 * Reply-flow tool definitions, usage instructions, and execution.
 * Stateless helpers used by ReplyGenerationService and AIService.
 */

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolCall, ToolResult, ToolSpec } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { FunctionCall, ToolDefinition } from '../types';

export interface ReplyToolOptions {
  nativeWebSearchEnabled?: boolean;
}

const SEARCH_TOOL_NAME = 'search';

/**
 * Get tool definitions for the reply flow.
 * Uses visibility scope + optional nativeWebSearch filter.
 */
export function getReplyToolDefs(toolManager: ToolManager, options?: ReplyToolOptions): ToolDefinition[] {
  let specs = toolManager.getToolsByScope('reply');
  if (options?.nativeWebSearchEnabled) {
    specs = specs.filter((t) => t.name !== SEARCH_TOOL_NAME);
  }
  return toolManager.toToolDefinitions(specs);
}

/**
 * Build the tool usage instruction string for prompt injection.
 */
export function buildToolUsageInstructions(
  toolManager: ToolManager,
  tools: ToolDefinition[],
  options: ReplyToolOptions | undefined,
  promptManager: PromptManager,
): string {
  if (tools.length === 0) {
    return promptManager.render(
      options?.nativeWebSearchEnabled ? 'llm.tool.no_tools.native_search' : 'llm.tool.no_tools.local',
    );
  }

  let specs = toolManager.getToolsByScope('reply');
  if (options?.nativeWebSearchEnabled) {
    specs = specs.filter((t) => t.name !== SEARCH_TOOL_NAME);
  }
  const specsByName = new Map<string, ToolSpec>(specs.map((s) => [s.name, s]));

  const toolList = tools
    .map((tool) => {
      const spec = specsByName.get(tool.name);
      const required = new Set(tool.parameters.required ?? []);
      const params = Object.entries(tool.parameters.properties ?? {})
        .map(([name, def]) => {
          const requiredLabel = required.has(name) ? '必填' : '可选';
          const enumLabel = Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
          return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
        })
        .join('; ');
      const usage = spec?.whenToUse?.trim();
      const examples =
        spec?.examples && spec.examples.length > 0 ? `\n  示例: ${spec.examples.slice(0, 2).join('；')}` : '';
      return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}${examples}`;
    })
    .join('\n');

  const nativeSearchNote = promptManager.render(
    options?.nativeWebSearchEnabled ? 'llm.tool.note.native_search' : 'llm.tool.note.local',
  );

  return promptManager.render('llm.tool.usage', { nativeSearchNote, toolList });
}

/**
 * Parse tool call arguments JSON.
 */
function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Execute a single tool call via ToolManager.
 * Used as toolExecutor callback in LLMService.generateWithTools.
 */
export async function executeToolCall(
  call: FunctionCall,
  context: HookContext,
  toolManager: ToolManager,
  hookManager: HookManager,
): Promise<unknown> {
  logger.info(`[replyTools] Executing tool: ${call.name}`);

  const toolSpec = toolManager.getTool(call.name);
  if (!toolSpec) {
    throw new Error(`Tool not found: ${call.name}`);
  }
  const executor = toolManager.getExecutor(toolSpec.executor);
  if (!executor) {
    throw new Error(`Executor not found for tool: ${call.name}`);
  }

  const parameters = parseToolArguments(call.arguments);
  const toolCall: ToolCall = {
    type: call.name,
    parameters,
    executor: toolSpec.executor,
  };

  const toolContext = ToolExecutionContextBuilder.fromHookContext(context).withToolResults(new Map()).build();

  const result: ToolResult = await toolManager.execute(toolCall, toolContext, hookManager, context);

  return result.data ?? result.reply;
}

// Backward-compatible aliases
export type ReplyToolDefinitionsOptions = ReplyToolOptions;
export type ReplySkillDefinitionsOptions = ReplyToolOptions;
export const getReplySkillDefinitions = getReplyToolDefs;
export const getReplyToolDefinitions = getReplyToolDefs;
export const buildSkillUsageInstructions = buildToolUsageInstructions;
export const executeSkillCall = executeToolCall;
