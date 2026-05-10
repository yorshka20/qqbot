// Echo Plugin - automatically converts admin messages to TTS

import type { MessageAPI } from '@/api/methods/MessageAPI';
import { CommandBuilder } from '@/command/CommandBuilder';
import type { CommandManager } from '@/command/CommandManager';
import { CommandContextBuilder } from '@/context/CommandContextBuilder';
import { hasWhitelistCapability } from '@/context/HookContextHelpers';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { WHITELIST_CAPABILITY } from '@/utils/whitelistCapabilities';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/**
 * Echo Plugin
 * Automatically converts admin messages (non-command, non-at-bot) to TTS
 */
@RegisterPlugin({
  name: 'echo',
  version: '1.0.0',
  description: 'Automatically converts admin messages to TTS',
})
export class EchoPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private hookManager!: HookManager;
  private messageAPI!: MessageAPI;

  async onInit(): Promise<void> {
    // Get CommandManager and HookManager from DI container
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    if (!this.commandManager) {
      throw new Error('CommandManager not found');
    }

    if (!this.hookManager) {
      throw new Error('HookManager not found');
    }

    if (!this.messageAPI) {
      throw new Error('MessageAPI not found');
    }
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
    // Whitelist and capability: never respond when denied or when group does not have echo capability
    if (!hasWhitelistCapability(context, WHITELIST_CAPABILITY.echo)) {
      return false;
    }

    const botSelfId = context.metadata.get('botSelfId');
    const config = getContainer().resolve<Config>(DITokens.CONFIG);
    const botConfig = config.getConfig().bot;

    const isEnabled = this.enabled;
    const isAdmin = MessageUtils.isAdmin(context.message.userId, botConfig);
    // Use context.command (routed before this hook) so we skip TTS for any command, including when
    // message.message starts with non-text (e.g. [Image:...]/i2v) and isCommand(message) would be false.
    const isCommand = context.command != null || MessageUtils.isCommand(context.message.message);
    const isAtBot = MessageUtils.isAtBot(context.message, botSelfId);

    // Check if message contains images or faces (emojis)
    // Only echo pure text messages
    const hasNonTextContent = this.hasNonTextContent(context.message);

    const shouldTrigger = isEnabled && isAdmin && !isCommand && !isAtBot && !hasNonTextContent;

    return shouldTrigger;
  }

  /**
   * Check if message contains non-text content (images or faces/emojis)
   * Returns true if message contains images or faces, false otherwise
   */
  private hasNonTextContent(message: HookContext['message']): boolean {
    const segments = message.segments;

    // If no segments, treat as pure text message
    if (!segments || segments.length === 0) {
      return false;
    }

    // Check if any segment is image or face
    return segments.some((segment) => {
      const segmentType = segment.type;
      return segmentType === 'image' || segmentType === 'face';
    });
  }

  /**
   * TTS is a side-channel echo, not a pipeline step. Run as a fire-and-forget
   * background task with a hard timeout so a slow/stuck provider can never
   * block the message pipeline.
   */
  private static readonly TTS_BACKGROUND_TIMEOUT_MS = 30_000;

  private runTTSInBackground(text: string, context: HookContext): void {
    if (!this.commandManager) {
      return;
    }
    if (MessageUtils.isCommand(text.trim())) {
      return;
    }

    const command = CommandBuilder.build('tts', [text, '--voice=派蒙']);
    const commandContext = CommandContextBuilder.fromHookContext(context).build();

    logger.info(`[EchoPlugin] Triggering TTS command for text: ${text.substring(0, 50)}...`);

    const task = (async () => {
      const result = await this.commandManager.execute(command, commandContext, this.hookManager, context);
      if (result.success && result.segments && result.segments.length > 0) {
        await this.messageAPI.sendFromContext(result.segments, context.message, 10000);
        logger.info(`[EchoPlugin] TTS sent successfully`);
      } else {
        logger.warn(`[EchoPlugin] TTS command failed or no segments: ${result.error || 'no segments'}`);
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`TTS background task exceeded ${EchoPlugin.TTS_BACKGROUND_TIMEOUT_MS}ms, discarded`)),
        EchoPlugin.TTS_BACKGROUND_TIMEOUT_MS,
      );
    });

    Promise.race([task, timeout])
      .catch((error) => {
        logger.warn('[EchoPlugin] TTS background task discarded:', error);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  /**
   * Hook: onMessagePreprocess
   * Kicks off TTS as a background task and returns immediately. The pipeline
   * must NOT wait on TTS — it is a side-channel output, not a prerequisite.
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 10,
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    if (!this.shouldTrigger(context)) {
      return true;
    }

    const messageText = context.message.message?.trim() || '';
    this.runTTSInBackground(messageText, context);

    return true;
  }
}
