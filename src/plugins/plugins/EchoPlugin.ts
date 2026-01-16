// Echo Plugin - automatically converts admin messages to TTS

import { CommandBuilder } from '@/command/CommandBuilder';
import { CommandManager } from '@/command/CommandManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/**
 * Echo Plugin
 * Automatically converts admin messages (non-command, non-at-bot) to TTS
 */
@Plugin({
  name: 'echo',
  version: '1.0.0',
  description: 'Automatically converts admin messages to TTS',
})
export class EchoPlugin extends PluginBase {
  private commandManager: CommandManager | null = null;
  private hookManager: HookManager | null = null;

  async onInit(): Promise<void> {
    // Get CommandManager and HookManager from DI container
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
  }

  /**
   * Toggle enabled state and return current state
   * @returns 'on' if enabled, 'off' if disabled
   */
  toggleEnabled(): 'on' | 'off' {
    this.enabled = !this.enabled;
    const state = this.enabled ? 'on' : 'off';
    logger.info(`[EchoPlugin] Toggled to ${state}`);
    return state;
  }

  /**
   * Get current enabled state
   */
  getEnabledState(): 'on' | 'off' {
    return this.enabled ? 'on' : 'off';
  }

  private shouldTrigger(context: HookContext): boolean {
    const botSelfId = context.metadata.get('botSelfId') as string;
    const config = this.context?.bot.getConfig();
    const botConfig = config?.bot;
    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    const isEnabled = this.enabled;
    const isAdmin = MessageUtils.isAdmin(context.message.userId, botConfig);
    const isCommand = MessageUtils.isCommand(context.message.message);
    const isAtBot = MessageUtils.isAtBot(context.message, botSelfId);

    logger.debug(
      `[EchoPlugin] shouldTrigger check | messageId=${messageId} | enabled=${isEnabled} | isAdmin=${isAdmin} | isCommand=${isCommand} | isAtBot=${isAtBot}`,
    );

    const shouldTrigger = isEnabled && isAdmin && !isCommand && !isAtBot;

    if (!shouldTrigger) {
      logger.debug(
        `[EchoPlugin] Not triggering | messageId=${messageId} | reason=${!isEnabled ? 'disabled' : !isAdmin ? 'not admin' : isCommand ? 'is command' : isAtBot ? 'is @bot' : 'unknown'}`,
      );
    }

    return shouldTrigger;
  }

  /**
   * Trigger TTS command programmatically
   * Executes command synchronously and sets reply in hookContext metadata
   */
  private async triggerTTSCommand(text: string, context: HookContext): Promise<void> {
    if (!this.commandManager) {
      logger.error('[EchoPlugin] CommandManager not available, cannot trigger TTS command');
      return;
    }

    try {
      // Build command using CommandBuilder
      const command = CommandBuilder.build('tts', [text]);

      // Construct CommandContext
      const commandContext = {
        userId: context.message.userId!,
        groupId: context.message.groupId,
        messageType: context.message.messageType,
        rawMessage: context.message.message,
        metadata: {
          senderRole: context.message.sender?.role,
        },
      };

      logger.info(`[EchoPlugin] Triggering TTS command for text: ${text.substring(0, 50)}...`);

      // Execute command with hookManager and hookContext to ensure reply is set in context
      const result = await this.commandManager.execute(command, commandContext, this.hookManager || undefined, context);

      if (result.success && result.message) {
        // Set reply in hookContext metadata (same pattern as CommandSystem)
        context.metadata.set('reply', result.message);
        logger.info(
          `[EchoPlugin] TTS command executed successfully, reply set | messageId=${context.message?.id || context.message?.messageId || 'unknown'}`,
        );
      } else {
        logger.warn(`[EchoPlugin] TTS command failed: ${result.error}`);
      }
    } catch (error) {
      logger.error('[EchoPlugin] Failed to trigger TTS command:', error);
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Check if message is from admin, not a command, and not @bot, then trigger TTS command
   * Executes synchronously to ensure reply is set before determineProcessingMode runs
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 10,
  })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    const messageId = context.message?.id || context.message?.messageId || 'unknown';
    logger.debug(`[EchoPlugin] onMessagePreprocess hook called | messageId=${messageId} | enabled=${this.enabled}`);

    if (!this.shouldTrigger(context)) {
      return true;
    }

    const messageText = context.message.message?.trim() || '';

    logger.info(`[EchoPlugin] Admin message detected | messageId=${messageId}`);

    // Trigger TTS command synchronously to ensure reply is set in hookContext
    // This allows the reply to be sent even if determineProcessingMode sets postProcessOnly
    await this.triggerTTSCommand(messageText, context);

    return true;
  }
}
