import type { ToolExecutionContext } from './types';

/**
 * Budget for a tool that does not declare one on `@Tool`. It covers everything
 * backed by a local store or a single bounded HTTP call; anything slower by
 * construction states its own `timeoutMs`.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export async function runWithToolDeadline<T>(
  name: string,
  timeoutMs: number,
  context: ToolExecutionContext,
  execute: (context: ToolExecutionContext) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => execute({ ...context, signal }))(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
