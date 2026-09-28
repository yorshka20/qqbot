import type { ToolExecutionContext } from './types';

export const TOOL_EXECUTION_TIMEOUT_MS = 10_000;

export async function runWithToolDeadline<T>(
  name: string,
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
          reject(new Error(`Tool ${name} timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`));
        }, TOOL_EXECUTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
