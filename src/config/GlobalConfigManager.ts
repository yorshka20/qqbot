// Global Config Manager - manages runtime global configuration (in-memory)

import type { ConversationConfigData } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { updateEnabledDisabled } from './ConfigUtils';

/**
 * Global Config Manager
 * Manages runtime global configuration (in-memory, not persisted)
 * Config is loaded from config.jsonc at startup and can be modified at runtime
 */
export class GlobalConfigManager {
  private globalConfig: ConversationConfigData = {
    commands: {
      enabled: [],
      disabled: [],
    },
    plugins: {
      enabled: [],
      disabled: [],
    },
    permissions: {
      users: {},
    },
  };

  /**
   * Get current global config
   */
  getConfig(): ConversationConfigData {
    return this.globalConfig;
  }

  /**
   * Update global config (partial update)
   */
  updateConfig(partialConfig: Partial<ConversationConfigData>): void {
    this.globalConfig = {
      commands: {
        enabled: partialConfig.commands?.enabled ?? this.globalConfig.commands?.enabled ?? [],
        disabled: partialConfig.commands?.disabled ?? this.globalConfig.commands?.disabled ?? [],
      },
      plugins: {
        enabled: partialConfig.plugins?.enabled ?? this.globalConfig.plugins?.enabled ?? [],
        disabled: partialConfig.plugins?.disabled ?? this.globalConfig.plugins?.disabled ?? [],
      },
      permissions: {
        users: {
          ...this.globalConfig.permissions?.users,
          ...partialConfig.permissions?.users,
        },
      },
    };
    logger.debug('[GlobalConfigManager] Updated global config');
  }

  /**
   * Enable a command globally
   */
  enableCommand(commandName: string): void {
    const { enabled, disabled } = updateEnabledDisabled(
      commandName,
      this.globalConfig.commands?.enabled ?? [],
      this.globalConfig.commands?.disabled ?? [],
      true,
    );

    this.updateConfig({
      commands: { enabled, disabled },
    });
  }

  /**
   * Disable a command globally
   */
  disableCommand(commandName: string): void {
    const { enabled, disabled } = updateEnabledDisabled(
      commandName,
      this.globalConfig.commands?.enabled ?? [],
      this.globalConfig.commands?.disabled ?? [],
      false,
    );

    this.updateConfig({
      commands: { enabled, disabled },
    });
  }

  /**
   * Enable a plugin globally
   */
  enablePlugin(pluginName: string): void {
    const { enabled, disabled } = updateEnabledDisabled(
      pluginName,
      this.globalConfig.plugins?.enabled ?? [],
      this.globalConfig.plugins?.disabled ?? [],
      true,
    );

    this.updateConfig({
      plugins: { enabled, disabled },
    });
  }

  /**
   * Disable a plugin globally
   */
  disablePlugin(pluginName: string): void {
    const { enabled, disabled } = updateEnabledDisabled(
      pluginName,
      this.globalConfig.plugins?.enabled ?? [],
      this.globalConfig.plugins?.disabled ?? [],
      false,
    );

    this.updateConfig({
      plugins: { enabled, disabled },
    });
  }

  /**
   * Reset global config to empty state
   * Called when system restarts (config.jsonc is reloaded)
   */
  reset(): void {
    this.globalConfig = {
      commands: {
        enabled: [],
        disabled: [],
      },
      plugins: {
        enabled: [],
        disabled: [],
      },
      permissions: {
        users: {},
      },
    };
    logger.debug('[GlobalConfigManager] Reset global config');
  }
}
