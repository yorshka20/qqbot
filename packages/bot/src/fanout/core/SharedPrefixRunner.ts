// SharedPrefixRunner — runs the tasks of one fan-out run over a single request envelope.
//
// Byte-identical envelopes are the whole point: DeepSeek's prefix cache compares the
// request from its first byte, and tool definitions plus response_format are rendered
// ahead of the messages, so a task with a different tool list or JSON mode misses the
// cache entirely. Tasks therefore cannot touch the envelope; they only add a suffix.

import type { LLMService } from '@/ai/services/LLMService';
import { executeToolCall } from '@/ai/tools/replyTools';
import type { ChatMessage, FunctionCall, ToolDefinition } from '@/ai/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { FanoutRun, FanoutTask, FanoutTaskOutput, FanoutTaskReport } from './types';

export interface FanoutEnvelope {
  provider: string;
  model?: string;
  system: string;
  tools: ToolDefinition[];
}

export interface PreparedTask<C> {
  task: FanoutTask<C>;
  params: unknown;
}

export interface SharedPrefixRunInput<C> {
  fanoutName: string;
  envelope: FanoutEnvelope;
  prefix: string;
  run: FanoutRun<C>;
  /** Already in execution order. */
  tasks: PreparedTask<C>[];
  hookContext: HookContext;
}

export interface SharedPrefixServices {
  llmService: LLMService;
  toolManager: ToolManager;
  hookManager: HookManager;
}

/** Prefix, a blank line, then the task. The task is the only part that may differ between calls. */
export function withTaskSuffix(prefix: string, suffix: string): string {
  return `${prefix}\n\n${suffix.trim()}`;
}

/**
 * Run every task. The first one goes alone until its first LLM round returns — that
 * request is what writes the prefix into the provider cache — and the rest start then,
 * concurrently. Waiting only for the first round keeps a slow tool (an image being drawn)
 * from holding back tasks that need nothing from it.
 */
export async function runSharedPrefixTasks<C>(
  input: SharedPrefixRunInput<C>,
  services: SharedPrefixServices,
): Promise<FanoutTaskReport[]> {
  const [first, ...rest] = input.tasks;
  if (!first) {
    return [];
  }

  let signalWarm = () => {};
  const warm = new Promise<void>((resolve) => {
    signalWarm = resolve;
  });
  const firstReport = runTask(first, input, services, signalWarm);
  await warm;
  const restReports = rest.map((prepared) => runTask(prepared, input, services, () => {}));
  return Promise.all([firstReport, ...restReports]);
}

async function runTask<C>(
  prepared: PreparedTask<C>,
  input: SharedPrefixRunInput<C>,
  services: SharedPrefixServices,
  onFirstRound: () => void,
): Promise<FanoutTaskReport> {
  const { task, params } = prepared;
  const { envelope } = input;
  const allowed = new Set(task.tools);
  let rounds = 0;

  const toolExecutor = (call: FunctionCall): Promise<unknown> => {
    if (!allowed.has(call.name)) {
      logger.warn(`[Fanout] ${input.fanoutName}/${task.name} called ${call.name}, which this task may not use`);
      return Promise.resolve(`本任务不可调用 ${call.name}。不要再调用它，直接按任务要求输出结果。`);
    }
    return executeToolCall(call, input.hookContext, services.toolManager, services.hookManager);
  };

  let report: FanoutTaskReport;
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: envelope.system },
      { role: 'user', content: withTaskSuffix(input.prefix, task.suffix(input.run, params)) },
    ];
    const response = await services.llmService
      .generateWithTools(
        messages,
        envelope.tools,
        {
          model: envelope.model,
          maxTokens: task.limits.maxTokens,
          timeout: task.limits.timeout,
          maxToolRounds: task.limits.maxToolRounds,
          toolExecutor,
          onProviderResolved: () => {
            rounds++;
            onFirstRound();
          },
        },
        envelope.provider,
      )
      .finally(onFirstRound);
    // A tool-less envelope short-circuits to a single plain generation, which reports no rounds.
    rounds = Math.max(rounds, 1);
    const output: FanoutTaskOutput = {
      text: response.text ?? '',
      toolCalls: response.toolCalls ?? [],
      usage: response.usage,
    };
    await task.handle(output, input.run, params);
    report = { name: task.name, status: 'ok', rounds, usage: response.usage };
  } catch (err) {
    onFirstRound();
    logger.error(`[Fanout] ${input.fanoutName}/${task.name} failed:`, err);
    report = { name: task.name, status: 'failed', rounds };
  }

  const usage = report.usage;
  logger.info(
    `[Fanout] fanout=${input.fanoutName} task=${task.name} status=${report.status} rounds=${report.rounds} promptTokens=${usage?.promptTokens ?? '-'} cachedPromptTokens=${usage?.cachedPromptTokens ?? '-'}`,
  );
  return report;
}
