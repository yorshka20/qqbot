// Hook Manager - manages and executes hooks

import { logger } from '@/utils/logger';
import type { HookContext, HookHandler, HookRegistration } from './hooks/types';

export type HookName =
  | 'onMessageReceived'
  | 'onMessagePreprocess'
  | 'onCommandDetected'
  | 'onCommandExecuted'
  | 'onMessageBeforeAI'
  | 'onAIGenerationStart'
  | 'onAIGenerationComplete'
  | 'onTaskAnalyzed'
  | 'onTaskBeforeExecute'
  | 'onTaskExecuted'
  | 'onMessageBeforeSend'
  | 'onMessageSent'
  | 'onError';

/**
 * Hook Manager
 * Manages hook registration and execution
 */
export class HookManager {
  private hooks = new Map<HookName, HookRegistration[]>();

  /**
   * Register a hook handler
   */
  register(
    hookName: HookName,
    handler: HookHandler,
    priority = 0,
    pluginName?: string,
  ): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }

    const registration: HookRegistration = {
      handler,
      priority,
      pluginName,
    };

    const hookList = this.hooks.get(hookName)!;
    hookList.push(registration);

    // Sort by priority (higher priority first)
    hookList.sort((a, b) => b.priority - a.priority);

    logger.debug(
      `[HookManager] Registered hook: ${hookName} (priority: ${priority}, plugin: ${pluginName || 'builtin'})`,
    );
  }

  /**
   * Unregister a hook handler
   */
  unregister(hookName: HookName, handler: HookHandler): boolean {
    const hookList = this.hooks.get(hookName);
    if (!hookList) {
      return false;
    }

    const index = hookList.findIndex((reg) => reg.handler === handler);
    if (index === -1) {
      return false;
    }

    hookList.splice(index, 1);
    logger.debug(`[HookManager] Unregistered hook: ${hookName}`);
    return true;
  }

  /**
   * Unregister all hooks from a plugin
   */
  unregisterPluginHooks(pluginName: string): void {
    let count = 0;

    for (const [hookName, hookList] of this.hooks.entries()) {
      const filtered = hookList.filter((reg) => {
        if (reg.pluginName === pluginName) {
          count++;
          return false;
        }
        return true;
      });
      this.hooks.set(hookName, filtered);
    }

    logger.info(
      `[HookManager] Unregistered ${count} hooks from plugin: ${pluginName}`,
    );
  }

  /**
   * Execute hooks for a given hook name
   * Returns false if execution should be interrupted
   */
  async execute(hookName: HookName, context: HookContext): Promise<boolean> {
    const hookList = this.hooks.get(hookName);
    if (!hookList || hookList.length === 0) {
      return true; // No hooks, continue execution
    }

    logger.debug(
      `[HookManager] Executing hook: ${hookName} (${hookList.length} handlers)`,
    );

    for (const registration of hookList) {
      try {
        const result = await registration.handler(context);

        // If handler returns false, interrupt execution
        if (result === false) {
          logger.debug(
            `[HookManager] Hook ${hookName} interrupted by handler (plugin: ${registration.pluginName || 'builtin'})`,
          );
          return false;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error(
          `[HookManager] Error in hook ${hookName} (plugin: ${registration.pluginName || 'builtin'}):`,
          err,
        );

        // Call onError hook if available
        if (hookName !== 'onError') {
          const errorContext: HookContext = {
            ...context,
            error: err,
          };
          await this.execute('onError', errorContext);
        }

        // Continue execution even if hook fails (don't interrupt)
      }
    }

    return true; // Continue execution
  }

  /**
   * Get all registered hooks for a hook name
   */
  getHooks(hookName: HookName): HookRegistration[] {
    return [...(this.hooks.get(hookName) || [])];
  }

  /**
   * Clear all hooks
   */
  clear(): void {
    this.hooks.clear();
    logger.info('[HookManager] Cleared all hooks');
  }
}
