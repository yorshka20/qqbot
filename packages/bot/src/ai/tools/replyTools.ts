/**
 * Reply-flow tool definitions, usage instructions, and execution.
 * Stateless helpers used by ReplyGenerationService and AIService.
 */

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import type { MessageSource } from '@/conversation/sources';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import type { ReplyVisibility, ToolCall, ToolResult, ToolSpec } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { FunctionCall, ToolDefinition } from '../types';

export interface ReplyToolOptions {
  nativeWebSearchEnabled?: boolean;
}

const SEARCH_TOOL_NAME = 'search';

/** Real-IM sources that get the full tool catalog by default. */
const REAL_IM_SOURCES: readonly MessageSource[] = ['qq-private', 'qq-group', 'discord'];

function resolveReplyVisibility(spec: ToolSpec): ReplyVisibility | null {
  const v = spec.visibility?.reply;
  if (v === undefined) return null;
  if (v === true) return {}; // legacy: defaults applied below
  return v;
}

/**
 * Filter reply-scope specs by source and admin status.
 */
export function filterToolsForReply(specs: ToolSpec[], source: MessageSource, isAdmin: boolean): ToolSpec[] {
  return specs.filter((spec) => {
    const rv = resolveReplyVisibility(spec);
    if (!rv) return false;
    if (rv.adminOnly && !isAdmin) return false;
    const sources = rv.sources ?? REAL_IM_SOURCES;
    return sources.includes(source);
  });
}

function selectReplySpecs(
  toolManager: ToolManager,
  source: MessageSource,
  isAdmin: boolean,
  options?: ReplyToolOptions,
): ToolSpec[] {
  let specs = toolManager.getToolsByScope('reply');
  specs = filterToolsForReply(specs, source, isAdmin);
  if (options?.nativeWebSearchEnabled) {
    specs = specs.filter((t) => t.name !== SEARCH_TOOL_NAME);
  }
  return specs;
}

/**
 * Get tool definitions for the reply flow.
 * Filters by source (real-IM only by default) and admin status.
 */
export function getReplyToolDefs(
  toolManager: ToolManager,
  source: MessageSource,
  isAdmin: boolean,
  options?: ReplyToolOptions,
): ToolDefinition[] {
  return toolManager.toToolDefinitions(selectReplySpecs(toolManager, source, isAdmin, options));
}

/**
 * Render ToolDefinition[] as a text catalog for providers WITHOUT native
 * function calling. Descriptions already carry whenToUse/examples (composed in
 * ToolManager.toToolDefinitions), so the catalog needs only name + description
 * + parameters. Shared by the reply flow and the agenda AgentLoop.
 */
export function formatToolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const required = new Set(tool.parameters.required ?? []);
      const params = Object.entries(tool.parameters.properties ?? {})
        .map(([name, def]) => {
          const requiredLabel = required.has(name) ? '必填' : '可选';
          const enumLabel = Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
          return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
        })
        .join('; ');
      return `- ${tool.name}: ${tool.description}${params ? `\n  参数: ${params}` : ''}`;
    })
    .join('\n');
}

/**
 * Build the tool usage instruction string for prompt injection.
 */
export function buildToolUsageInstructions(
  tools: ToolDefinition[],
  options: ReplyToolOptions | undefined,
  promptManager: PromptManager,
  nativeFunctionCalling: boolean,
): string {
  if (tools.length === 0) {
    return promptManager.render(
      options?.nativeWebSearchEnabled ? 'llm.tool.no_tools.native_search' : 'llm.tool.no_tools.local',
    );
  }

  // Native FC: tools[] schema already conveys the catalog. Render only behaviour note.
  if (nativeFunctionCalling) {
    return promptManager.render(
      options?.nativeWebSearchEnabled ? 'llm.tool.note.native_search' : 'llm.tool.note.local',
    );
  }

  const nativeSearchNote = promptManager.render(
    options?.nativeWebSearchEnabled ? 'llm.tool.note.native_search' : 'llm.tool.note.local',
  );

  return promptManager.render('llm.tool.usage', { nativeSearchNote, toolList: formatToolCatalog(tools) });
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

  // Per ToolResult contract: `reply` is the LLM-facing message. Fall back to `data` only
  // when reply is empty — otherwise non-trivial `data` would silently shadow the reply
  // (the bug that left research subagent output invisible to the main agent).
  const baseResult: unknown = result.reply ? result.reply : (result.data ?? '');

  // Loop-control sentinel: end_turn terminates the agentic loop after this round.
  if (result.endTurn) {
    return { __endTurn: true, result: baseResult };
  }

  // When tool returns multimodal content (e.g. images), wrap with sentinel so LLMService
  // can inject ContentPart[] into the conversation for vision providers.
  if (result.contentParts?.length) {
    return { __contentParts: result.contentParts, result: baseResult };
  }

  return baseResult;
}

// Backward-compatible aliases
export type ReplyToolDefinitionsOptions = ReplyToolOptions;
export type ReplySkillDefinitionsOptions = ReplyToolOptions;
export const getReplySkillDefinitions = getReplyToolDefs;
export const getReplyToolDefinitions = getReplyToolDefs;
export const buildSkillUsageInstructions = buildToolUsageInstructions;
export const executeSkillCall = executeToolCall;
