// Conversation Config Service - manages conversation-level configuration with fallback to global config

import type { DatabaseAdapter } from '@/database/base/DatabaseAdapter';
import type { ConversationConfigData } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { updateEnabledDisabled } from './ConfigUtils';
import type { GlobalConfigManager } from './GlobalConfigManager';

export type SessionType = 'user' | 'group';

/**
 * Conversation Config Service
 * Manages conversation-level configuration with fallback to global config
 */
export class ConversationConfigService {
  // In-memory cache for conversation configs
  private configCache = new Map<string, ConversationConfigData>();

  constructor(
    private databaseAdapter: DatabaseAdapter,
    private globalConfigManager: GlobalConfigManager,
  ) { }

  /**
   * Get conversation config key for cache
   */
  private getCacheKey(sessionId: string, sessionType: SessionType): string {
    return `${sessionType}:${sessionId}`;
  }

  /**
   * Get raw conversation config (without global merge)
   * Used internally for update operations to avoid saving global config data
   */
  private async getRawConfig(sessionId: string, sessionType: SessionType): Promise<ConversationConfigData> {
    const cacheKey = this.getCacheKey(sessionId, sessionType);

    // Check cache first
    if (this.configCache.has(cacheKey)) {
      return this.configCache.get(cacheKey)!;
    }

    // Load from database
    const model = this.databaseAdapter.getModel('conversationConfigs');
    const configRecord = await model.findOne({
      sessionId,
      sessionType,
    });

    let configData: ConversationConfigData = {};

    if (configRecord) {
      configData = configRecord.config;
      // Update cache
      this.configCache.set(cacheKey, configData);
    }

    return configData;
  }

  /**
   * Get conversation config with fallback to global config
   */
  async getConfig(sessionId: string, sessionType: SessionType): Promise<ConversationConfigData> {
    const rawConfig = await this.getRawConfig(sessionId, sessionType);
    return this.mergeWithGlobal(rawConfig);
  }

  /**
   * Merge conversation config with global config (fallback)
   * If conversation config has commands/plugins defined, use them entirely (don't merge with global)
   * This ensures that conversation-level config takes precedence and avoids conflicts
   */
  private mergeWithGlobal(conversationConfig: ConversationConfigData): ConversationConfigData {
    const globalConfig = this.globalConfigManager.getConfig();

    // If conversation config has commands defined, use them entirely
    // Otherwise, fallback to global config
    const commands = conversationConfig.commands !== undefined
      ? {
        enabled: conversationConfig.commands.enabled ?? [],
        disabled: conversationConfig.commands.disabled ?? [],
      }
      : {
        enabled: globalConfig.commands?.enabled ?? [],
        disabled: globalConfig.commands?.disabled ?? [],
      };

    // If conversation config has plugins defined, use them entirely
    // Otherwise, fallback to global config
    const plugins = conversationConfig.plugins !== undefined
      ? {
        enabled: conversationConfig.plugins.enabled ?? [],
        disabled: conversationConfig.plugins.disabled ?? [],
      }
      : {
        enabled: globalConfig.plugins?.enabled ?? [],
        disabled: globalConfig.plugins?.disabled ?? [],
      };

    return {
      commands,
      plugins,
      permissions: {
        users: {
          ...globalConfig.permissions?.users,
          ...conversationConfig.permissions?.users,
        },
      },
      nsfwMode: conversationConfig.nsfwMode ?? false,
    };
  }

  /**
   * Update conversation config (partial update)
   */
  async updateConfig(
    sessionId: string,
    sessionType: SessionType,
    partialConfig: Partial<ConversationConfigData>,
  ): Promise<void> {
    const cacheKey = this.getCacheKey(sessionId, sessionType);
    const model = this.databaseAdapter.getModel('conversationConfigs');

    // Get existing config or create new
    let existing = await model.findOne({
      sessionId,
      sessionType,
    });

    let configData: ConversationConfigData;

    if (existing) {
      // Merge with existing config
      configData = {
        ...existing.config,
        commands: {
          ...existing.config.commands,
          ...partialConfig.commands,
        },
        plugins: {
          ...existing.config.plugins,
          ...partialConfig.plugins,
        },
        permissions: {
          users: {
            ...existing.config.permissions?.users,
            ...partialConfig.permissions?.users,
          },
        },
        // Merge providers if provided
        providers: partialConfig.providers !== undefined
          ? partialConfig.providers
          : existing.config.providers,
        // Merge nsfwMode if provided
        nsfwMode: partialConfig.nsfwMode !== undefined ? partialConfig.nsfwMode : existing.config.nsfwMode,
      };

      // Update in database
      await model.update(existing.id, {
        config: configData,
      });
    } else {
      // Create new config
      configData = partialConfig as ConversationConfigData;

      await model.create({
        sessionId,
        sessionType,
        config: configData,
      });
    }

    // Update cache
    this.configCache.set(cacheKey, configData);
    logger.debug(`[ConversationConfigService] Updated config for ${sessionType}:${sessionId}`);
  }

  /**
   * Delete conversation config
   */
  async deleteConfig(sessionId: string, sessionType: SessionType): Promise<void> {
    const cacheKey = this.getCacheKey(sessionId, sessionType);
    const model = this.databaseAdapter.getModel('conversationConfigs');

    const existing = await model.findOne({
      sessionId,
      sessionType,
    });

    if (existing) {
      await model.delete(existing.id);
      this.configCache.delete(cacheKey);
      logger.debug(`[ConversationConfigService] Deleted config for ${sessionType}:${sessionId}`);
    }
  }

  /**
   * Load all conversation configs from database into memory
   * Called at system startup
   */
  async loadAllConfigs(): Promise<void> {
    const model = this.databaseAdapter.getModel('conversationConfigs');
    const allConfigs = await model.find({});

    this.configCache.clear();

    for (const config of allConfigs) {
      const cacheKey = this.getCacheKey(config.sessionId, config.sessionType);
      this.configCache.set(cacheKey, config.config);
    }

    logger.info(`[ConversationConfigService] Loaded ${allConfigs.length} conversation configs into memory`);
  }

  /**
   * Check if a command is enabled for a conversation
   */
  async getCommandEnabled(
    commandName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<boolean | null> {
    const config = await this.getConfig(sessionId, sessionType);
    const lowerName = commandName.toLowerCase();

    // Check disabled list first
    if (config.commands?.disabled?.includes(lowerName)) {
      return false;
    }

    // Check enabled list
    if (config.commands?.enabled?.includes(lowerName)) {
      return true;
    }

    // If not in either list, return null to indicate fallback to global/default
    return null;
  }

  /**
   * Check if a plugin is enabled for a conversation
   */
  async getPluginEnabled(
    pluginName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<boolean | null> {
    const config = await this.getConfig(sessionId, sessionType);
    const lowerName = pluginName.toLowerCase();

    // Check disabled list first
    if (config.plugins?.disabled?.includes(lowerName)) {
      return false;
    }

    // Check enabled list
    if (config.plugins?.enabled?.includes(lowerName)) {
      return true;
    }

    // If not in either list, return null to indicate fallback to global/default
    return null;
  }

  /**
   * Get user permissions for a conversation
   */
  async getUserPermissions(
    userId: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<string[] | null> {
    const config = await this.getConfig(sessionId, sessionType);
    return config.permissions?.users?.[userId] ?? null;
  }

  /**
   * Enable a command for a conversation
   */
  async enableCommand(
    commandName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<void> {
    // Get raw conversation config (without global merge) to avoid saving global config data
    const rawConfig = await this.getRawConfig(sessionId, sessionType);
    const { enabled, disabled } = updateEnabledDisabled(
      commandName,
      rawConfig.commands?.enabled ?? [],
      rawConfig.commands?.disabled ?? [],
      true,
    );

    await this.updateConfig(sessionId, sessionType, {
      commands: { enabled, disabled },
    });
  }

  /**
   * Disable a command for a conversation
   */
  async disableCommand(
    commandName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<void> {
    // Get raw conversation config (without global merge) to avoid saving global config data
    const rawConfig = await this.getRawConfig(sessionId, sessionType);
    const { enabled, disabled } = updateEnabledDisabled(
      commandName,
      rawConfig.commands?.enabled ?? [],
      rawConfig.commands?.disabled ?? [],
      false,
    );

    await this.updateConfig(sessionId, sessionType, {
      commands: { enabled, disabled },
    });
  }

  /**
   * Enable a plugin for a conversation
   */
  async enablePlugin(
    pluginName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<void> {
    // Get raw conversation config (without global merge) to avoid saving global config data
    const rawConfig = await this.getRawConfig(sessionId, sessionType);
    const { enabled, disabled } = updateEnabledDisabled(
      pluginName,
      rawConfig.plugins?.enabled ?? [],
      rawConfig.plugins?.disabled ?? [],
      true,
    );

    await this.updateConfig(sessionId, sessionType, {
      plugins: { enabled, disabled },
    });
  }

  /**
   * Disable a plugin for a conversation
   */
  async disablePlugin(
    pluginName: string,
    sessionId: string,
    sessionType: SessionType,
  ): Promise<void> {
    // Get raw conversation config (without global merge) to avoid saving global config data
    const rawConfig = await this.getRawConfig(sessionId, sessionType);
    const { enabled, disabled } = updateEnabledDisabled(
      pluginName,
      rawConfig.plugins?.enabled ?? [],
      rawConfig.plugins?.disabled ?? [],
      false,
    );

    await this.updateConfig(sessionId, sessionType, {
      plugins: { enabled, disabled },
    });
  }
}
