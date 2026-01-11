// Hook Registry - registers hooks from plugins

import type { Plugin } from './types';
import type { HookManager } from './HookManager';
import { logger } from '@/utils/logger';

/**
 * Hook Registry
 * Registers hooks from plugins to HookManager
 */
export class HookRegistry {
  constructor(private hookManager: HookManager) {}

  /**
   * Register all hooks from a plugin
   */
  registerPluginHooks(plugin: Plugin, pluginName: string): void {
    const hookNames: Array<keyof Plugin> = [
      'onMessageReceived',
      'onMessagePreprocess',
      'onCommandDetected',
      'onCommandExecuted',
      'onMessageBeforeAI',
      'onAIGenerationStart',
      'onAIGenerationComplete',
      'onTaskAnalyzed',
      'onTaskBeforeExecute',
      'onTaskExecuted',
      'onMessageBeforeSend',
      'onMessageSent',
      'onError',
    ];

    let registeredCount = 0;

    for (const hookName of hookNames) {
      const handler = plugin[hookName];
      if (typeof handler === 'function') {
        this.hookManager.register(
          hookName as any,
          handler as any,
          0, // Default priority
          pluginName,
        );
        registeredCount++;
      }
    }

    if (registeredCount > 0) {
      logger.info(
        `[HookRegistry] Registered ${registeredCount} hooks from plugin: ${pluginName}`,
      );
    }
  }

  /**
   * Unregister all hooks from a plugin
   */
  unregisterPluginHooks(pluginName: string): void {
    this.hookManager.unregisterPluginHooks(pluginName);
  }
}
