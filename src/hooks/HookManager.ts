// Hook Manager - manages and executes hooks

import { logger } from '@/utils/logger';
import {
  getCoreHookPriority,
  getExtensionHookPriority,
} from './HookPriority';
import type { HookContext, HookHandler, HookRegistration } from './types';

// Core hook names - only message lifecycle hooks
export type CoreHookName =
  | 'onMessageReceived'
  | 'onMessagePreprocess'
  | 'onMessageBeforeSend'
  | 'onMessageSent'
  | 'onError';

// Extended hook names - can be registered by extensions (command system, task system, etc.)
export type ExtendedHookName = string;

// Hook name union - core hooks are always available, extended hooks are optional
export type HookName = CoreHookName | ExtendedHookName;

/**
 * Hook Manager
 * Manages hook registration and execution
 */
export class HookManager {
  private hooks = new Map<HookName, HookRegistration[]>();

  /**
   * Register a hook handler
   * Supports both core hooks and extended hooks (registered by extensions)
   *
   * @param hookName - Hook name (core or extended)
   * @param handler - Hook handler function
   * @param priority - Priority (higher = executed earlier). If not provided, uses default priority for the hook
   * @param pluginName - Plugin/extension name that registered this hook
   */
  register(
    hookName: HookName,
    handler: HookHandler,
    priority?: number,
    pluginName?: string,
  ): void {
    // Validate core hook names
    const coreHooks: CoreHookName[] = [
      'onMessageReceived',
      'onMessagePreprocess',
      'onMessageBeforeSend',
      'onMessageSent',
      'onError',
    ];
    const isCoreHook = coreHooks.includes(hookName as CoreHookName);

    // Use default priority if not provided
    let finalPriority = priority;
    if (finalPriority === undefined) {
      if (isCoreHook) {
        finalPriority = getCoreHookPriority(hookName as CoreHookName);
      } else {
        finalPriority = getExtensionHookPriority(hookName);
      }
    }

    if (!isCoreHook && !this.hooks.has(hookName)) {
      // Extended hook - log that it's being registered
      logger.debug(
        `[HookManager] Registering extended hook: ${hookName} (from: ${pluginName || 'extension'})`,
      );
    }

    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }

    const hookList = this.hooks.get(hookName)!;

    // Check if handler is already registered (prevent duplicate registration)
    const existingRegistration = hookList.find(
      (reg) => reg.handler === handler,
    );
    if (existingRegistration) {
      logger.debug(
        `[HookManager] Handler already registered for hook: ${hookName} (plugin: ${pluginName || 'unknown'}), skipping duplicate`,
      );
      return;
    }

    const registration: HookRegistration = {
      handler,
      priority: finalPriority,
      pluginName,
    };

    hookList.push(registration);

    // Sort by priority (higher priority first)
    hookList.sort((a, b) => b.priority - a.priority);

    logger.debug(
      `[HookManager] Registered hook: ${hookName} (priority: ${finalPriority}, plugin: ${pluginName || 'builtin'})`,
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
      logger.debug(
        `[HookManager] No handlers registered for hook: ${hookName}`,
      );
      return true; // No hooks, continue execution
    }

    const messageId =
      context.message?.id || context.message?.messageId || 'unknown';
    logger.info(
      `[HookManager] Executing hook: ${hookName} | messageId=${messageId} | handlerCount=${hookList.length} | handlers=[${hookList.map((r) => `${r.pluginName || 'builtin'}:${r.priority}`).join(', ')}]`,
    );

    for (let i = 0; i < hookList.length; i++) {
      const registration = hookList[i];
      const handlerName = `${registration.pluginName || 'builtin'}:${registration.priority}`;

      try {
        logger.info(
          `[HookManager] Executing handler [${i + 1}/${hookList.length}]: ${handlerName} | hook=${hookName} | messageId=${messageId}`,
        );

        const result = await registration.handler(context);

        // If handler returns false, interrupt execution
        if (result === false) {
          logger.info(
            `[HookManager] ✗ Hook ${hookName} interrupted by handler | handler=${handlerName} | messageId=${messageId}`,
          );
          return false;
        }

        logger.info(
          `[HookManager] ✓ Handler completed | handler=${handlerName} | hook=${hookName} | messageId=${messageId}`,
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error(
          `[HookManager] ✗ Error in hook ${hookName} | handler=${handlerName} | messageId=${messageId} | error=${err.message}`,
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

    logger.info(
      `[HookManager] ✓ All handlers completed for hook: ${hookName} | messageId=${messageId}`,
    );
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
