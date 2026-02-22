// Process-stage interceptor - allows plugins to handle messages before CommandSystem/TaskSystem

import type { HookContext } from '@/hooks/types';

/**
 * Interceptor that can handle a message at the start of PROCESS stage.
 * When an interceptor handles a message, it sets context.reply and PROCESS-stage systems (CommandSystem, TaskSystem) are skipped.
 */
export interface ProcessStageInterceptor {
  /**
   * Whether this message should be handled by this interceptor.
   * When true, handle() will be called and PROCESS-stage systems will be skipped.
   * May be async (e.g. to read session config).
   */
  shouldIntercept(context: HookContext): boolean | Promise<boolean>;

  /**
   * Handle the message (e.g. generate reply using a fixed flow).
   * Must set context.reply when handling.
   */
  handle(context: HookContext): Promise<void>;
}

/**
 * Registry of process-stage interceptors.
 * Plugins register interceptors so that when a message is in a special mode (e.g. NSFW),
 * the interceptor can generate the reply and skip normal command/task processing.
 */
export class ProcessStageInterceptorRegistry {
  private interceptors: ProcessStageInterceptor[] = [];

  register(interceptor: ProcessStageInterceptor): void {
    this.interceptors.push(interceptor);
  }

  unregister(interceptor: ProcessStageInterceptor): void {
    const index = this.interceptors.indexOf(interceptor);
    if (index !== -1) {
      this.interceptors.splice(index, 1);
    }
  }

  getInterceptors(): ProcessStageInterceptor[] {
    return [...this.interceptors];
  }
}
