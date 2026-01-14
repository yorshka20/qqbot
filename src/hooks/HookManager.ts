// Hook Manager - manages and executes hooks

import { logger } from '@/utils/logger';
import type { CoreHookName, HookContext, HookHandler, HookName, HookRegistration } from './types';

/**
 * Hook Manager
 * Manages hook registration and execution
 */
export class HookManager {
  /**
   * Core hook names - only message lifecycle hooks
   * Hook can be extended by other systems based on core hooks.
   */
  static coreHooks: CoreHookName[] = [
    'onMessageReceived',
    'onMessagePreprocess',
    'onMessageBeforeSend',
    'onMessageSent',
    'onError',
  ];

  private hooks = new Map<HookName, HookRegistration[]>();

  /**
   * Register a hook handler or declare a hook
   * Supports both core hooks and extended hooks (registered by extensions)
   * If handler is not provided, only declares the hook (initializes hook list for plugin registration)
   *
   * @param hookName - Hook name (core or extended)
   * @param priority - Priority (lower = executed earlier). If not provided, uses default priority for the hook
   * @param pluginName - Plugin/extension name that registered this hook
   */
  register(hookName: HookName, priority: number): void {
    // Initialize hook list if needed
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }

    const hookList = this.hooks.get(hookName)!;

    // Check if handler is already registered (prevent duplicate registration)
    if (hookList.some((reg) => reg.hookName === hookName)) {
      return;
    }

    // Register handler
    hookList.push({
      hookName,
      priority,
      handlers: [],
    });

    // Sort by priority (lower priority first)
    hookList.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Add a handler to a hook
   * The hook must be registered first (via register method)
   *
   * @param hookName - Hook name
   * @param handler - Handler function
   * @param priority - Priority
   */
  addHandler(hookName: HookName, handler: HookHandler, priority: number): void {
    // Ensure hook is registered first
    if (!this.hooks.has(hookName)) {
      this.register(hookName, priority);
    }

    const hookList = this.hooks.get(hookName)!;

    // Find or create registration with matching priority
    let registration = hookList.find((reg) => reg.priority === priority);
    if (!registration) {
      registration = {
        hookName,
        priority,
        handlers: [],
      };
      hookList.push(registration);
      // Sort by priority (lower priority first)
      hookList.sort((a, b) => a.priority - b.priority);
    }

    // Check if handler is already registered (prevent duplicate)
    if (registration.handlers.includes(handler)) {
      return;
    }

    // Add handler
    registration.handlers.push(handler);
  }

  /**
   * Remove a handler from a hook
   */
  removeHandler(hookName: HookName, handler: HookHandler): boolean {
    const hookList = this.hooks.get(hookName);
    if (!hookList) {
      return false;
    }

    for (const registration of hookList) {
      const index = registration.handlers.indexOf(handler);
      if (index !== -1) {
        registration.handlers.splice(index, 1);
        // Remove registration if no handlers left
        if (registration.handlers.length === 0) {
          const regIndex = hookList.indexOf(registration);
          if (regIndex !== -1) {
            hookList.splice(regIndex, 1);
          }
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Unregister a hook (remove all registrations for this hook)
   */
  unregister(hookName: HookName): boolean {
    return this.hooks.delete(hookName);
  }

  /**
   * Execute hooks for a given hook name
   * Returns false if execution should be interrupted
   */
  async execute(hookName: HookName, context: HookContext): Promise<boolean> {
    const hookList = this.hooks.get(hookName);
    if (!hookList || hookList.length === 0) {
      logger.debug(`[HookManager] No handlers registered for hook: ${hookName}`);
      return true;
    }

    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    logger.info(
      `🎣 [HookManager] Executing hook: ${hookName} | messageId=${messageId} | registrationCount=${hookList.length}`,
    );

    for (const registration of hookList) {
      for (let j = 0; j < registration.handlers.length; j++) {
        const handler = registration.handlers[j];
        const handlerName = `${registration.hookName}:${registration.priority}[${j}]`;

        try {
          logger.debug(`[HookManager] Executing handler: ${handlerName} | hook=${hookName} | messageId=${messageId}`);

          const result = await handler(context);

          if (!result) {
            logger.info(
              `🚫 [HookManager] Hook ${hookName} interrupted by handler | handler=${handlerName} | messageId=${messageId}`,
            );
            return false;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error('Unknown error');
          logger.error(
            `🚫 [HookManager] Error in hook ${hookName} | handler=${handlerName} | messageId=${messageId} | error=${err.message}`,
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
    }

    logger.info(`✅ [HookManager] All handlers completed for hook: ${hookName} | messageId=${messageId}`);
    return true;
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
