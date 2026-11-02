import type { AgentExecutor, ExecutorModel } from './executors';
import type { AgentRunOptions } from './types';

/** A task was asked to run with a model or effort its executor does not offer. */
export class AgentRunOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunOptionsError';
  }
}

/**
 * Resolve the model and effort a task runs with. Explicit options are checked
 * against the executor's catalog so a typo is refused instead of reaching the
 * CLI; the catalog is only consulted when an option was given.
 */
export async function resolveRunOptions(
  executor: AgentExecutor,
  options: AgentRunOptions,
): Promise<{ model: string; effort?: string }> {
  const model = options.model || executor.defaultModel;
  const effort = options.effort || executor.defaultEffort;
  if (!options.model && !options.effort) {
    return { model, effort };
  }

  const models = await executor.listModels();
  checkRunOptions(executor.name, models, model, options);
  return { model, effort };
}

export function checkRunOptions(
  executorName: string,
  models: ExecutorModel[],
  model: string,
  options: AgentRunOptions,
): void {
  const entry = models.find((m) => m.id === model);
  if (options.model && !entry) {
    throw new AgentRunOptionsError(
      `未知模型 "${options.model}"。${executorName} 可用模型：${models.map((m) => m.id).join(', ')}`,
    );
  }
  if (!options.effort) {
    return;
  }
  if (!entry) {
    throw new AgentRunOptionsError(
      `默认模型 ${model} 不在 ${executorName} 的模型列表中，无法校验强度；请用 --model 指定模型。可用模型：${models.map((m) => m.id).join(', ')}`,
    );
  }
  if (!entry.efforts.includes(options.effort)) {
    throw new AgentRunOptionsError(
      `模型 ${model} 不支持强度 "${options.effort}"。可用强度：${entry.efforts.join(', ')}`,
    );
  }
}
