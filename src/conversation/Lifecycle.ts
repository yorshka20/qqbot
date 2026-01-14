// Message Lifecycle Orchestrator - orchestrates the message processing lifecycle

import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import type { CommandRouter } from './CommandRouter';

/**
 * Message Lifecycle Orchestrator
 * Orchestrates the entire message processing lifecycle
 * Coordinates all stages: RECEIVE → PREPROCESS → PROCESS → PREPARE → SEND → COMPLETE
 */
export class Lifecycle {
  readonly name = 'lifecycle';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS; // Lifecycle manages all stages

  private systems = new Map<SystemStage, System[]>();
  private hookManager: HookManager;
  private commandRouter?: CommandRouter;

  private readonly LOG_PREFIX = '[Lifecycle]';

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
    logger.debug(`${this.LOG_PREFIX} Initialized`);
  }

  enabled(): boolean {
    return true;
  }

  /**
   * Set command router
   */
  setCommandRouter(router: CommandRouter): void {
    this.commandRouter = router;
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
    }
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
    logger.info(`${this.LOG_PREFIX} Stage: PROCESS | messageId=${messageId}`);

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
      logger.info(`${this.LOG_PREFIX} Command routed | command=${command.name} | messageId=${messageId}`);
    } else {
      logger.debug(
        `${this.LOG_PREFIX} No command detected | message=${context.message.message.substring(0, 50)} | messageId=${messageId}`,
      );
    }
  }

  /**
   * Determine processing mode (reply vs collect-only)
   * Sets postProcessOnly flag based on message type and whitelist status
   *
   * Reply logic:
   * - Commands: always reply
   * - Private chat: only reply if user is in whitelist (no @bot required)
   * - Group chat: must be in whitelist (user or group) AND @bot to trigger reply
   */
  private determineProcessingMode(context: HookContext, messageId: string): void {
    // Skip if postProcessOnly is already set (e.g., by whitelist plugin for non-whitelist users)
    const existingPostProcessOnly = context.metadata.get('postProcessOnly') as boolean;
    if (existingPostProcessOnly) {
      return;
    }

    // Ignore bot's own messages
    const botSelfId = context.metadata.get('botSelfId') as string;
    const messageUserId = context.message.userId?.toString();
    if (botSelfId && messageUserId && botSelfId === messageUserId) {
      context.metadata.set('postProcessOnly', true);
      return;
    }

    // Commands always get replies
    if (context.command) {
      return;
    }

    const messageType = context.message.messageType;
    const isWhitelistUser = context.metadata.get('whitelistUser') as boolean;
    const isWhitelistGroup = context.metadata.get('whitelistGroup') as boolean;

    // Private chat: only reply if user is in whitelist
    if (messageType === 'private') {
      if (isWhitelistUser) {
        return;
      }

      // Non-whitelist user in private chat - should not reach here (WhitelistPlugin should have set postProcessOnly)
      context.metadata.set('postProcessOnly', true);
      return;
    }

    // Group chat logic: must be in whitelist (user or group) AND @bot to trigger reply
    // First check if user or group is in whitelist
    if (!isWhitelistUser && !isWhitelistGroup) {
      context.metadata.set('postProcessOnly', true);
      return;
    }

    // In whitelist, but still need @bot for group chat
    const isAtBot = this.checkIsAtBot(context.message, botSelfId);
    if (!isAtBot) {
      context.metadata.set('postProcessOnly', true);
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
   * Delegates to MessageUtils for centralized implementation
   */
  private checkIsAtBot(
    message: {
      segments?: Array<{ type: string; data?: Record<string, unknown> }>;
    },
    botSelfId?: string | null,
  ): boolean {
    return MessageUtils.isAtBot(message, botSelfId);
  }
}
