// Echo Plugin - automatically converts admin messages to TTS

import { CommandBuilder } from '@/command/CommandBuilder';
import { CommandManager } from '@/command/CommandManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginContext } from '../types';

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

  async onInit(context: PluginContext): Promise<void> {
    this.context = context;

    // Get CommandManager from DI container
    try {
      const container = getContainer();
      this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
      logger.debug('[EchoPlugin] CommandManager resolved from DI container');
    } catch (error) {
      logger.warn('[EchoPlugin] Failed to resolve CommandManager from DI container:', error);
    }
  }

  private shouldTrigger(context: HookContext): boolean {
    const botSelfId = context.metadata.get('botSelfId') as string;
    const config = this.context?.bot.getConfig();
    const botConfig = config?.bot;

    return (
      this.enabled &&
      MessageUtils.isAdmin(context.message.userId, botConfig) &&
      !MessageUtils.isCommand(context.message.message) &&
      !MessageUtils.isAtBot(context.message, botSelfId)
    );
  }

  /**
   * Trigger TTS command programmatically
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

      // Execute command (without hook manager to avoid recursive hooks)
      const result = await this.commandManager.execute(command, commandContext);

      if (!result.success) {
        logger.warn(`[EchoPlugin] TTS command failed: ${result.error}`);
      }
    } catch (error) {
      logger.error('[EchoPlugin] Failed to trigger TTS command:', error);
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Check if message is from admin, not a command, and not @bot, then trigger TTS command
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.shouldTrigger(context)) {
      return;
    }

    const messageText = context.message.message?.trim() || '';
    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    logger.info(`[EchoPlugin] Admin message detected | messageId=${messageId}`);

    // Trigger TTS command asynchronously (don't block message processing)
    this.triggerTTSCommand(messageText, context).catch((error) => {
      logger.error(`[EchoPlugin] Failed to trigger TTS command | messageId=${messageId}:`, error);
    });

    return;
  }
}
