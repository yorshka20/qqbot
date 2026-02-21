// Message Lifecycle Orchestrator - orchestrates the message processing lifecycle

import { ParsedCommand } from '@/command';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
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

  private systems = new Map<SystemStage, System[]>();

  constructor(
    private hookManager: HookManager,
    private commandRouter: CommandRouter,
  ) {}

  enabled(): boolean {
    return true;
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
    stageSystems.sort((a, b) => b.priority - a.priority);

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

    logger.debug(`[Lifecycle] Starting lifecycle | messageId=${messageId}`);

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
      logger.info(`[Lifecycle] Lifecycle completed | messageId=${messageId} | duration=${duration}ms`);

      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      const duration = Date.now() - startTime;
      logger.error(`[Lifecycle] Lifecycle failed | messageId=${messageId} | duration=${duration}ms`, err);

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
    logger.debug(`[Lifecycle] 🟦[1] Stage: ON_MESSAGE_RECEIVED`);

    // Execute hook
    const shouldContinue = await this.hookManager.execute('onMessageReceived', context);
    if (!shouldContinue) {
      logger.debug(`[Lifecycle] Interrupted at ON_MESSAGE_RECEIVED hook | messageId=${messageId}`);
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
    logger.debug(`[Lifecycle] 🟦[2] Stage: PREPROCESS`);

    // Route command before preprocess hook so plugins (e.g. EchoPlugin TTS) can skip when context.command is set.
    // This avoids TTS triggering on command messages where message.message starts with non-text (e.g. [Image:...]/i2v).
    this.routeCommand(context);

    // Execute hook and check return value
    const shouldContinue = await this.hookManager.execute('onMessagePreprocess', context);
    if (!shouldContinue) {
      logger.debug(`[Lifecycle] Interrupted at PREPROCESS hook | messageId=${messageId}`);
      return false;
    }

    // Execute systems
    return await this.executeSystems(SystemStage.PREPROCESS, context, messageId);
  }

  /**
   * Stage 3: PROCESS
   * Main processing: command execution, task analysis, AI generation
   */
  private async executeStageProcess(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`[Lifecycle] 🟦[3] Stage: PROCESS`);

    // Execute systems (CommandSystem, TaskSystem, etc.)
    return await this.executeSystems(SystemStage.PROCESS, context, messageId);
  }

  /**
   * Stage 4: PREPARE
   * Prepare message for sending
   */
  private async executeStagePrepare(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`[Lifecycle] 🟦[4] Stage: PREPARE`);

    // Execute hook and check return value
    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', context);
    if (!shouldContinue) {
      logger.debug(`[Lifecycle] Interrupted at PREPARE hook | messageId=${messageId}`);
      return false;
    }

    // Execute systems
    return await this.executeSystems(SystemStage.PREPARE, context, messageId);
  }

  /**
   * Stage 5: SEND
   * Send message (actual sending is handled by MessagePipeline)
   */
  private async executeStageSend(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`[Lifecycle] 🟦[5] Stage: SEND`);

    // Execute systems
    return await this.executeSystems(SystemStage.SEND, context, messageId);
  }

  /**
   * Stage 6: COMPLETE
   * Final cleanup and completion
   */
  private async executeStageComplete(context: HookContext, messageId: string): Promise<boolean> {
    logger.debug(`[Lifecycle] 🟧[6] Stage: COMPLETE`);

    // Execute systems (non-blocking, errors are logged but don't fail)
    await this.executeSystems(SystemStage.COMPLETE, context, messageId);

    // Hook: onMessageComplete (e.g. for proactive conversation plugin to schedule debounced analysis)
    await this.hookManager.execute('onMessageComplete', context);

    return true;
  }

  /**
   * Route command from message
   * Prefers segments if available to properly handle reply messages
   */
  private routeCommand(context: HookContext): void {
    let command: ParsedCommand | null = null;

    // If segments are available, use them to extract text (skipping reply/at segments)
    // This ensures commands in reply messages are properly detected
    if (context.message.segments && context.message.segments.length > 0) {
      // Convert segments to MessageSegment[] type
      const segments = context.message.segments as unknown as MessageSegment[];
      command = this.commandRouter.routeFromSegments(segments);
    }

    // Fallback to message string if no command found from segments.
    // Parser.parse() handles mixed-content (e.g. [Image:...]/i2v prompt) internally.
    if (!command) {
      command = this.commandRouter.route(context.message.message);
    }

    if (command) {
      context.command = command;
      logger.info(`[Lifecycle] Command routed | command=${command.name}`);
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

    logger.debug(`[Lifecycle] Executing ${systems.length} system(s) at stage: ${stage}`);

    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];

      // Check if system is enabled before executing
      if (!system.enabled()) {
        logger.debug(
          `[Lifecycle] System disabled, skipping | system=${system.name} | stage=${stage} | messageId=${messageId}`,
        );
        continue;
      }

      const systemStartTime = Date.now();

      try {
        logger.debug(`[Lifecycle] Executing system | system=${system.name} | stage=${stage} | messageId=${messageId}`);

        // core execute method
        const shouldContinue = await system.execute(context);

        const systemDuration = Date.now() - systemStartTime;

        if (!shouldContinue) {
          logger.debug(
            `[Lifecycle] System interrupted | system=${system.name} | stage=${stage} | duration=${systemDuration}ms | messageId=${messageId}`,
          );
          return false;
        }

        logger.debug(`[Lifecycle] System completed | system=${system.name} | duration=${systemDuration}ms`);
      } catch (error) {
        const systemDuration = Date.now() - systemStartTime;
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error(
          `[Lifecycle] System failed | system=${system.name} | stage=${stage} | duration=${systemDuration}ms | error=${err.message} | messageId=${messageId}`,
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
    const errorContext = HookContextBuilder.fromContext(context).withError(error).build();

    try {
      await this.hookManager.execute('onError', errorContext);
      logger.debug(`[Lifecycle] Error hook executed | messageId=${messageId}`);
    } catch (hookError) {
      logger.error(`[Lifecycle] Error hook failed | messageId=${messageId}`, hookError);
    }
  }

  /**
   * Get message ID from context
   */
  private getMessageId(context: HookContext): string {
    return context.message?.id || context.message?.messageId?.toString() || 'unknown';
  }
}
