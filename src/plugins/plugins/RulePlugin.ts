// Rule Plugin - executes commands on schedule based on configured rules

import { CommandBuilder } from '@/command/CommandBuilder';
import type { CommandManager } from '@/command/CommandManager';
import { CommandContextBuilder } from '@/context/CommandContextBuilder';
import type { ContextManager } from '@/context/ContextManager';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { ProtocolName } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import { logger } from '@/utils/logger';
import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import { Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/**
 * Rule configuration for a single scheduled command
 */
interface RuleConfig {
  /**
   * Group ID where the command will be executed
   */
  groupId: string;
  /**
   * Cron schedule expression (e.g., "0 20 * * *" for daily at 20:00)
   */
  schedule: string;
  /**
   * Command name to execute
   */
  command: string;
  /**
   * Command arguments
   */
  args: string[];
}

/**
 * Rule Plugin configuration
 */
interface RulePluginConfig {
  /**
   * List of rules to execute
   */
  rules?: RuleConfig[];
  /**
   * Timezone for cron jobs (default: "Asia/Tokyo")
   * Must be a valid IANA timezone identifier (e.g., "Asia/Tokyo", "Asia/Shanghai", "UTC")
   */
  timezone?: string;
}

/**
 * Rule Plugin
 * Executes commands on schedule based on configured rules
 */
@Plugin({
  name: 'rule',
  version: '1.0.0',
  description: 'Executes commands on schedule based on configured rules',
})
export class RulePlugin extends PluginBase {
  private commandManager!: CommandManager;
  private hookManager!: HookManager;
  private contextManager!: ContextManager;
  private cronJobs = new Map<string, ScheduledTask>();
  private botSelfId: number | null = null;
  private preferredProtocol: ProtocolName = 'milky';
  private timezone: string = 'Asia/Tokyo'; // Default timezone

  async onInit(): Promise<void> {
    // Get dependencies from DI container
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
    this.contextManager = container.resolve<ContextManager>(DITokens.CONTEXT_MANAGER);

    if (!this.commandManager) {
      throw new Error('[RulePlugin] CommandManager not found');
    }

    if (!this.hookManager) {
      throw new Error('[RulePlugin] HookManager not found');
    }

    if (!this.contextManager) {
      throw new Error('[RulePlugin] ContextManager not found');
    }

    // Get bot configuration
    const config = this.context?.bot.getConfig();
    if (config) {
      // Get bot selfId from config
      const botConfig = config.bot;
      if (botConfig && botConfig.selfId) {
        const selfIdNum = parseInt(botConfig.selfId);
        if (!isNaN(selfIdNum)) {
          this.botSelfId = selfIdNum;
        }
      }

      // Get preferred protocol
      const apiConfig = config.api;
      if (apiConfig.preferredProtocol) {
        this.preferredProtocol = apiConfig.preferredProtocol;
      }
    }

    logger.info('[RulePlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    logger.info('[RulePlugin] Enabling rule plugin');

    // Clear any existing cron jobs (in case of re-enable or restart)
    // This ensures we don't have duplicate jobs after server restart
    if (this.cronJobs.size > 0) {
      logger.debug(`[RulePlugin] Clearing ${this.cronJobs.size} existing cron job(s) before re-registering`);
      for (const [ruleId, job] of this.cronJobs.entries()) {
        job.stop();
      }
      this.cronJobs.clear();
    }

    // Load and validate configuration from config.jsonc (persisted)
    // Configuration is loaded from config.jsonc file, which persists across server restarts
    const pluginConfig = this.pluginConfig?.config as RulePluginConfig;
    if (!pluginConfig) {
      logger.warn('[RulePlugin] No configuration found in config.jsonc, plugin will be disabled');
      this.enabled = false;
      return;
    }

    // Load timezone from config (default: Asia/Tokyo)
    if (pluginConfig.timezone) {
      this.timezone = pluginConfig.timezone;
    }
    logger.info(`[RulePlugin] Using timezone: ${this.timezone}`);

    const rules = pluginConfig.rules || [];
    if (rules.length === 0) {
      return;
    }

    logger.info(`[RulePlugin] Loading ${rules.length} rule(s) from config.jsonc (persisted configuration)`);

    // Validate and register all rules
    // Rules are registered as cron jobs that will persist until server restart
    // After restart, this onEnable() method will be called again, reloading rules from config.jsonc
    for (const rule of rules) {
      try {
        this.validateRule(rule);
        this.registerRule(rule);
      } catch (error) {
        logger.error(`[RulePlugin] Failed to register rule for group ${rule.groupId}:`, error);
      }
    }

    logger.info(`[RulePlugin] Successfully registered ${this.cronJobs.size} cron job(s)`);
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[RulePlugin] Disabling rule plugin');

    // Stop all cron jobs
    for (const [ruleId, job] of this.cronJobs.entries()) {
      job.stop();
      logger.debug(`[RulePlugin] Stopped cron job: ${ruleId}`);
    }

    this.cronJobs.clear();
    logger.info('[RulePlugin] All cron jobs stopped');
  }

  /**
   * Validate a rule configuration
   */
  private validateRule(rule: RuleConfig): void {
    if (!rule.groupId || typeof rule.groupId !== 'string') {
      throw new Error('groupId is required and must be a string');
    }

    if (!rule.schedule || typeof rule.schedule !== 'string') {
      throw new Error('schedule is required and must be a string (cron expression)');
    }

    if (!rule.command || typeof rule.command !== 'string') {
      throw new Error('command is required and must be a string');
    }

    if (!Array.isArray(rule.args)) {
      throw new Error('args must be an array');
    }

    // Validate cron expression (basic check)
    const cronPattern = /^(\*|([0-9]|[1-5][0-9])|\*\/[0-9]+)\s+(\*|([0-9]|[1-5][0-9])|\*\/[0-9]+)\s+(\*|([1-9]|[12][0-9]|3[01])|\*\/[0-9]+)\s+(\*|([1-9]|1[0-2])|\*\/[0-9]+)\s+(\*|([0-6])|\*\/[0-9]+)$/;
    if (!cronPattern.test(rule.schedule)) {
      throw new Error(`Invalid cron expression: ${rule.schedule}`);
    }
  }

  /**
   * Register a rule and create a cron job for it
   * Cron jobs are stored in memory and will be recreated on server restart
   * by calling onEnable() which reloads configuration from config.jsonc
   */
  private registerRule(rule: RuleConfig): void {
    const ruleId = `${rule.groupId}-${rule.command}-${rule.schedule}`;

    // Check if rule already exists (should not happen after clearing in onEnable, but safety check)
    if (this.cronJobs.has(ruleId)) {
      return;
    }

    // Create cron job
    // Note: Cron jobs are stored in memory and will be lost on server restart
    // However, configuration is persisted in config.jsonc, so onEnable() will recreate them
    const job = schedule(
      rule.schedule,
      () => {
        this.executeRule(rule).catch((error) => {
          logger.error(`[RulePlugin] Error executing rule ${ruleId}:`, error);
        });
      },
      {
        scheduled: true,
        timezone: this.timezone,
      },
    );

    this.cronJobs.set(ruleId, job);
  }

  /**
   * Execute a rule by running the configured command
   */
  private async executeRule(rule: RuleConfig): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const groupId = parseInt(rule.groupId);
    if (isNaN(groupId)) {
      logger.error(`[RulePlugin] Invalid groupId: ${rule.groupId}`);
      return;
    }

    // Use bot selfId as userId, or fallback to a default value
    const userId = this.botSelfId || 0;

    // Execute command (cmd command now supports multiple commands natively)
    try {
      logger.info(
        `[RulePlugin] Executing rule: group=${groupId}, command=${rule.command}, args=${rule.args.join(' ')}`,
      );

      // Build command
      const command = CommandBuilder.build(rule.command, rule.args);

      // Build conversation context
      const conversationContext = this.contextManager.buildContext(command.raw, {
        sessionId: groupId.toString(),
        sessionType: 'group',
        userId,
        groupId,
      });

      // Build synthetic message for HookContext
      const syntheticMessage = {
        id: `rule_${Date.now()}_${Math.random()}`,
        type: 'message' as const,
        timestamp: Date.now(),
        protocol: this.preferredProtocol,
        userId,
        groupId,
        messageId: undefined,
        messageType: 'group' as const,
        message: command.raw,
        segments: [],
        messageScene: 'group',
      };

      // Build HookContext
      const hookContext = HookContextBuilder.create()
        .withSyntheticMessage(syntheticMessage)
        .withCommand(command)
        .withConversationContext(conversationContext)
        .withMetadata('sessionId', groupId.toString())
        .withMetadata('sessionType', 'group')
        .withMetadata('botSelfId', userId.toString())
        .build();

      // Build CommandContext
      // Mark as system execution to bypass permission checks (bot-initiated commands)
      const commandContext = CommandContextBuilder.fromHookContext(hookContext)
        .withMetadataEntry('isSystemExecution', true)
        .build();

      // Execute command
      const result = await this.commandManager.execute(command, commandContext, this.hookManager, hookContext);

      if (result.success) {
        logger.info(`[RulePlugin] Rule executed successfully: group=${groupId}, command=${rule.command}`);
      } else {
        logger.warn(`[RulePlugin] Rule execution failed: group=${groupId}, command=${rule.command}, error=${result.error}`);
      }
    } catch (error) {
      logger.error(`[RulePlugin] Error executing rule for group ${groupId}:`, error);
    }
  }

}
