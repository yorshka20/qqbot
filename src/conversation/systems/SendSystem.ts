// Send System - handles message delivery (normal or forward) and error notification

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { SendMessageResult } from '@/api/types';
import { getReplyContent } from '@/context/HookContextHelpers';
import type { System, SystemContext } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';
import { getLanRelayRuntime } from '@/lan';
import { getProtocolAdapter, isProtocolRegistered } from '@/protocol/ProtocolRegistry';
import { logger } from '@/utils/logger';

/**
 * Send System
 * Pure message delivery. All checks and transformations happen in PREPARE stage before this.
 * Reads reply content and sends via the appropriate API (forward or direct).
 * Also registers an onError hook handler to send error messages to users.
 */
export class SendSystem implements System {
  readonly name = 'send';
  readonly version = '1.0.0';
  readonly stage = SystemStage.SEND;
  readonly priority = SystemPriority.Send;

  /** Guard against recursive error sending (e.g. if sending the error message itself fails). */
  private sendingError = false;

  constructor(
    private messageAPI: MessageAPI,
    private hookManager: HookManager,
  ) {}

  enabled(): boolean {
    return true;
  }

  initialize(_context: SystemContext): void {
    this.hookManager.addHandler('onError', this.handleError.bind(this), getHookPriority('onError', 'NORMAL'));
  }

  async execute(context: HookContext): Promise<boolean> {
    const replyContent = getReplyContent(context);

    // Nothing to send
    if (!replyContent?.segments || replyContent.segments.length === 0) {
      return true;
    }

    // Hook: onMessageBeforeSend — final check before sending
    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', context);
    if (!shouldContinue) {
      logger.warn('[SendSystem] Message sending interrupted by onMessageBeforeSend hook');
      return true; // Don't fail the pipeline, just skip sending
    }

    const event = context.message;
    const protocolRegistered = isProtocolRegistered(event.protocol);
    const useForward =
      replyContent.metadata?.sendAsForward === true &&
      (protocolRegistered ? getProtocolAdapter(event.protocol).supportsForwardMessage() : true);
    logger.debug(`[SendSystem] Sending | useForward=${useForward} | protocol=${event.protocol}`);

    let sentMessageResponse: SendMessageResult;

    // LAN-relay branch: when no IM adapter is registered for this event's
    // protocol, normally that's a fatal misconfiguration. The exception is
    // a LAN-relay client instance — it never opens IM connections itself,
    // so we route the outbound send to the host machine that does. See
    // src/lan/ and the lanRelay config block for context.
    const relay = getLanRelayRuntime();
    if (!protocolRegistered && !relay?.isClientMode()) {
      throw new Error(
        `Protocol "${event.protocol}" is not registered. Connect the IM protocol on this instance, or set lanRelay.enabled + instanceRole client with a reachable host.`,
      );
    }
    if (!protocolRegistered && relay?.isClientMode()) {
      if (useForward) {
        // Forward replies need the bot's own QQ id as the synthetic sender of
        // the forward node — pass it across the wire so the host can use the
        // same id (rather than its own selfId, which may differ).
        const botSelfId = Number(context.metadata.get('botSelfId'));
        if (Number.isNaN(botSelfId) || botSelfId <= 0) {
          throw new Error("Forward relay requires bot self ID. Set config.bot.selfId to the bot's own QQ user id.");
        }
        sentMessageResponse = await relay.relayOutboundSend({
          segments: replyContent.segments,
          event,
          useForward: true,
          botSelfIdForForward: botSelfId,
        });
      } else {
        sentMessageResponse = await relay.relayOutboundSend({
          segments: replyContent.segments,
          event,
          useForward: false,
        });
      }
    } else if (useForward) {
      const botSelfId = Number(context.metadata.get('botSelfId'));
      if (Number.isNaN(botSelfId) || botSelfId <= 0) {
        throw new Error("Forward message requires bot self ID. Set config.bot.selfId to the bot's own QQ user id.");
      }
      sentMessageResponse = await this.messageAPI.sendForwardFromContext(
        [{ segments: replyContent.segments, senderName: 'Bot' }],
        event,
        60000,
        { botUserId: botSelfId },
      );
    } else {
      sentMessageResponse = await this.messageAPI.sendFromContext(replyContent.segments, event, 60000);
    }

    // Store response for downstream hooks/systems
    context.sentMessageResponse = sentMessageResponse;

    // Hook: onMessageSent (post-send notification, not a check)
    await this.hookManager.execute('onMessageSent', context);

    return true;
  }

  /**
   * onError hook handler — send a user-facing error message.
   * Uses a re-entrancy guard to prevent infinite recursion if the error send itself fails.
   */
  private async handleError(context: HookContext): Promise<boolean> {
    if (this.sendingError) {
      logger.warn('[SendSystem] Skipping error notification to avoid recursive send');
      return true;
    }

    const error = context.error;
    if (!error) return true;

    const event = context.message;
    if (!event?.protocol) return true;

    const errorText = `抱歉，处理消息时出错：${error.message || '未知错误'}`;

    this.sendingError = true;
    try {
      // Same LAN-relay branch as the main send path: a client instance has no
      // local IM adapter, so even error notifications must go via the host.
      const relay = getLanRelayRuntime();
      if (!isProtocolRegistered(event.protocol) && relay?.isClientMode()) {
        await relay.relayOutboundSend({
          segments: [{ type: 'text', data: { text: errorText } }],
          event,
          useForward: false,
        });
      } else {
        await this.messageAPI.sendFromContext([{ type: 'text', data: { text: errorText } }], event, 10000);
      }
      logger.debug('[SendSystem] Error message sent to user');
    } catch (sendError) {
      logger.error('[SendSystem] Failed to send error message to user', sendError);
    } finally {
      this.sendingError = false;
    }

    return true;
  }
}
