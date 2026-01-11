// Lifecycle System - core system that manages the message processing lifecycle

import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import type { CommandRouter } from './CommandRouter';

/**
 * Lifecycle System
 * Core system that manages the entire message processing lifecycle
 * Orchestrates all stages: RECEIVE → PREPROCESS → PROCESS → PREPARE → SEND → COMPLETE
 */
export class LifecycleSystem implements System {
  readonly name = 'lifecycle';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS; // Lifecycle manages all stages

  private systems = new Map<SystemStage, System[]>();
  private hookManager: HookManager;
  private commandRouter?: CommandRouter;

  private readonly LOG_PREFIX = '[LifecycleSystem]';

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
    logger.debug(`${this.LOG_PREFIX} Initialized`);
  }

  /**
   * Set command router
   */
  setCommandRouter(router: CommandRouter): void {
    this.commandRouter = router;
    logger.debug(`${this.LOG_PREFIX} Command router configured`);
  }

  /**
   * Register a system
   */
  registerSystem(system: System): void {
    const stage = system.stage;
    if (!this.systems.has(stage)) {
      this.systems.set(stage, []);
    }

    const stageSystems = this.systems.get(stage)!;
    stageSystems.push(system);

    // Sort by priority (higher first)
    stageSystems.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Register extension hooks if provided
    // Extension hooks are declared to make them available for plugins to subscribe
    if (system.getExtensionHooks) {
      const hooks = system.getExtensionHooks();
      for (const hookDef of hooks) {
        // Declare hook (initialize hook list for plugin registration)
        this.hookManager.register(hookDef.hookName, hookDef.priority);
      }

      if (hooks.length > 0) {
        logger.debug(`${this.LOG_PREFIX} Declared ${hooks.length} extension hooks from ${system.name}`);
      }
    }

    const priority = system.priority ?? 0;
    logger.info(`${this.LOG_PREFIX} System registered | name=${system.name} | stage=${stage} | priority=${priority}`);
  }

  /**
   * Execute lifecycle - main entry point
   */
  async execute(context: HookContext): Promise<boolean> {
    const startTime = Date.now();
    const messageId = this.getMessageId(context);

    logger.debug(`${this.LOG_PREFIX} Starting lifecycle | messageId=${messageId}`);

    try {
      // execute stages in order
      const stages = [
        this.executeStageReceive.bind(this),
        this.executeStagePreprocess.bind(this),
        this.executeStageProcess.bind(this),
        this.executeStagePrepare.bind(this),
        this.executeStageSend.bind(this),
        this.executeStageComplete.bind(this),
      ];

      for (const stageFn of stages) {
        const result = await stageFn(context, messageId);
        // if stage fails, interrupt lifecycle
        if (!result) return false;
      }

      const duration = Date.now() - startTime;
      logger.info(`${this.LOG_PREFIX} Lifecycle completed | messageId=${messageId} | duration=${duration}ms`);

      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      const duration = Date.now() - startTime;
      logger.error(
        `${this.LOG_PREFIX} Lifecycle failed | messageId=${messageId} | duration=${duration}ms | error=${err.message}`,
        err,
      );

      // Execute error hook
      await this.handleError(context, err, messageId);
      return false;
    }
  }

  /**
   * Stage 1: ON_MESSAGE_RECEIVED
   * Initial message reception and validation
   */
  private async executeStageReceive(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: ON_MESSAGE_RECEIVED`);

    // Execute hook
    const shouldContinue = await this.hookManager.execute('onMessageReceived', context);
    if (!shouldContinue) {
      logger.debug(`${this.LOG_PREFIX} Interrupted at ON_MESSAGE_RECEIVED hook | messageId=${messageId}`);
      return false;
    }

    // Execute systems
    return await this.executeSystems(SystemStage.ON_MESSAGE_RECEIVED, context, messageId);
  }

  /**
   * Stage 2: PREPROCESS
   * Message preprocessing, command routing, and initial filtering
   */
  private async executeStagePreprocess(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: PREPROCESS`);

    // Execute hook
    await this.hookManager.execute('onMessagePreprocess', context);

    // Route command (moved from PROCESS stage for better logical flow)
    this.routeCommand(context, messageId);

    // Execute systems
    return await this.executeSystems(SystemStage.PREPROCESS, context, messageId);
  }

  /**
   * Stage 3: PROCESS
   * Main processing: command execution, task analysis, AI generation
   */
  private async executeStageProcess(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: PROCESS`);

    // Determine if message should be processed for reply
    // This check happens after command routing to avoid unnecessary processing
    this.determineProcessingMode(context, messageId);

    // Execute systems (CommandSystem, TaskSystem, etc.)
    return await this.executeSystems(SystemStage.PROCESS, context, messageId);
  }

  /**
   * Stage 4: PREPARE
   * Prepare message for sending
   */
  private async executeStagePrepare(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: PREPARE`);

    // Execute hook
    await this.hookManager.execute('onMessageBeforeSend', context);

    // Execute systems
    return await this.executeSystems(SystemStage.PREPARE, context, messageId);
  }

  /**
   * Stage 5: SEND
   * Send message (actual sending is handled by MessagePipeline)
   */
  private async executeStageSend(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: SEND`);

    // Execute systems
    return await this.executeSystems(SystemStage.SEND, context, messageId);
  }

  /**
   * Stage 6: COMPLETE
   * Final cleanup and completion
   */
  private async executeStageComplete(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`${this.LOG_PREFIX} Stage: COMPLETE`);

    // Execute hook
    await this.hookManager.execute('onMessageSent', context);

    // Execute systems (non-blocking, errors are logged but don't fail)
    await this.executeSystems(SystemStage.COMPLETE, context, messageId);

    return true;
  }

  /**
   * Route command from message
   */
  private routeCommand(context: HookContext, messageId: string): void {
    if (!this.commandRouter) {
      logger.debug(`${this.LOG_PREFIX} Command router not configured | messageId=${messageId}`);
      return;
    }

    const command = this.commandRouter.route(context.message.message);
    if (command) {
      context.command = command;
      logger.debug(`${this.LOG_PREFIX} Command routed | command=${command.name} | messageId=${messageId}`);
    }
  }

  /**
   * Determine processing mode (reply vs collect-only)
   * Sets postProcessOnly flag if message is not a command and not @bot
   */
  private determineProcessingMode(context: HookContext, messageId: string): void {
    // Skip if postProcessOnly is already set (e.g., by whitelist plugin)
    const existingPostProcessOnly = context.metadata.get('postProcessOnly') as boolean;
    if (existingPostProcessOnly) {
      logger.debug(`${this.LOG_PREFIX} postProcessOnly already set | messageId=${messageId}`);
      return;
    }

    // If command exists, process normally
    if (context.command) {
      logger.debug(
        `${this.LOG_PREFIX} Command detected, normal processing | messageId=${messageId} | command=${context.command.name}`,
      );
      return;
    }

    // Check if message is @bot
    const botSelfId = context.metadata.get('botSelfId') as string;
    const isAtBot = this.checkIsAtBot(context.message, botSelfId);

    if (!isAtBot) {
      // Not a command and not @bot - collect only, no reply
      context.metadata.set('postProcessOnly', true);
      logger.debug(
        `${this.LOG_PREFIX} Set postProcessOnly=true | messageId=${messageId} | reason=not_command_and_not_at_bot`,
      );
    } else {
      logger.debug(`${this.LOG_PREFIX} Message @bot, normal processing | messageId=${messageId}`);
    }
  }

  /**
   * Execute all systems at a specific stage
   */
  private async executeSystems(stage: SystemStage, context: HookContext, messageId: string): Promise<boolean> {
    const systems = this.systems.get(stage) || [];

    if (systems.length === 0) {
      return true;
    }

    logger.debug(`${this.LOG_PREFIX} Executing ${systems.length} system(s) at stage: ${stage}`);

    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      const systemStartTime = Date.now();

      try {
        const shouldContinue = await system.execute(context);
        const systemDuration = Date.now() - systemStartTime;

        if (!shouldContinue) {
          logger.debug(
            `${this.LOG_PREFIX} System interrupted | system=${system.name} | stage=${stage} | duration=${systemDuration}ms | messageId=${messageId}`,
          );
          return false;
        }

        logger.debug(`${this.LOG_PREFIX} System completed | system=${system.name} | duration=${systemDuration}ms`);
      } catch (error) {
        const systemDuration = Date.now() - systemStartTime;
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error(
          `${this.LOG_PREFIX} System failed | system=${system.name} | stage=${stage} | duration=${systemDuration}ms | error=${err.message} | messageId=${messageId}`,
          error,
        );
        // Continue with other systems even if one fails
      }
    }

    return true;
  }

  /**
   * Handle error and execute error hook
   */
  private async handleError(context: HookContext, error: Error, messageId: string): Promise<void> {
    const errorContext: HookContext = {
      ...context,
      error,
    };

    try {
      await this.hookManager.execute('onError', errorContext);
      logger.debug(`${this.LOG_PREFIX} Error hook executed | messageId=${messageId}`);
    } catch (hookError) {
      logger.error(`${this.LOG_PREFIX} Error hook failed | messageId=${messageId}`, hookError);
    }
  }

  /**
   * Get message ID from context
   */
  private getMessageId(context: HookContext): string {
    return context.message?.id || context.message?.messageId?.toString() || 'unknown';
  }

  /**
   * Check if message is @bot itself
   * Supports multiple protocols: Milky (mention) and OneBot11 (at)
   */
  private checkIsAtBot(
    message: {
      segments?: Array<{ type: string; data?: Record<string, unknown> }>;
    },
    botSelfId?: string | null,
  ): boolean {
    // If bot selfId is not configured, cannot determine
    if (!botSelfId || botSelfId === '') {
      return false;
    }

    // Convert botSelfId to number for comparison
    const botSelfIdNum = parseInt(botSelfId, 10);
    if (isNaN(botSelfIdNum)) {
      return false;
    }

    // Check if message has segments
    if (!message.segments || message.segments.length === 0) {
      return false;
    }

    // Check if any segment is an 'at' or 'mention' segment targeting bot selfId
    for (const segment of message.segments) {
      if (!segment.data) {
        continue;
      }

      let atUserId: number | string | undefined;

      // Handle Milky protocol (mention type)
      if (segment.type === 'mention') {
        const userId = segment.data.user_id;
        if (typeof userId === 'number' || typeof userId === 'string') {
          atUserId = userId;
        }
      }
      // Handle OneBot11 protocol (at type)
      else if (segment.type === 'at') {
        const qq = segment.data.qq;
        if (typeof qq === 'number' || typeof qq === 'string') {
          atUserId = qq;
        }
      }

      if (atUserId !== undefined) {
        // Convert to number for comparison
        const atUserIdNum = typeof atUserId === 'string' ? parseInt(atUserId, 10) : atUserId;
        if (!isNaN(atUserIdNum) && atUserIdNum === botSelfIdNum) {
          return true;
        }
      }
    }

    return false;
  }
}
