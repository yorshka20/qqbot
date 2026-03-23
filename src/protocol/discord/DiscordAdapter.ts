// Discord protocol adapter implementation
// Event normalization and API conversion only — connection lifecycle is handled by DiscordConnection.

import type { SendMessageResult, SendTarget } from '@/api/types';
import { APIContext } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { ProtocolAdapter, resolveAction } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import { executeDiscordAPI } from './DiscordAPIConverter';
import type { DiscordConnection } from './DiscordConnection';
import { DiscordEventNormalizer } from './DiscordEventNormalizer';

export class DiscordAdapter extends ProtocolAdapter {
  private discordConnection: DiscordConnection;

  constructor(config: ProtocolConfig, connection: DiscordConnection) {
    super(config, connection);
    this.discordConnection = connection;
  }

  getProtocolName(): ProtocolName {
    return 'discord';
  }

  /** Discord segments are passed through — adapter's sendAPI handles conversion via executeDiscordAPI. */
  async sendMessage(
    message: string | MessageSegment[],
    target: SendTarget,
    timeout = 10000,
  ): Promise<SendMessageResult> {
    const { action, params } = resolveAction(target);
    const ctx = new APIContext(action, { ...params, message }, 'discord', timeout);
    return this.sendAPI<SendMessageResult>(ctx);
  }

  /**
   * normalizeEvent is required by the base class but unused for Discord.
   * Discord events arrive via discord.js EventEmitter, not raw WebSocket messages.
   */
  normalizeEvent(_rawEvent: unknown): BaseEvent | null {
    return DiscordEventNormalizer.normalizeEvent(_rawEvent);
  }

  /**
   * Override sendAPI to use discord.js methods instead of WebSocket.
   */
  async sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse> {
    if (!this.isConnected()) {
      throw new Error('Discord protocol is not connected');
    }

    if (this.config.mockSendMessage) {
      logger.info(`[DiscordAdapter] Mock API call: ${context.action} ${JSON.stringify(context.params)}`);
      return { message_id: `mock_${Date.now()}` } as TResponse;
    }

    const client = this.discordConnection.getClient();
    const result = await executeDiscordAPI(client, context.action, context.params);
    return result as TResponse;
  }

  /**
   * Override onEvent to register discord.js event listeners instead of WebSocket message handler.
   */
  onEvent(callback: (event: BaseEvent) => void): void {
    const client = this.discordConnection.getClient();

    client.on('messageCreate', (message) => {
      const normalized = DiscordEventNormalizer.normalizeMessageCreate(message);
      if (normalized) {
        callback(normalized);
      }
    });

    client.on('messageDelete', (message) => {
      const normalized = DiscordEventNormalizer.normalizeMessageDelete(message);
      if (normalized) {
        callback(normalized);
      }
    });

    client.on('messageReactionAdd', (reaction, user) => {
      if (reaction.message.partial) return;
      if (user.partial) return;
      const normalized = DiscordEventNormalizer.normalizeReaction(
        reaction as import('discord.js').MessageReaction,
        user as import('discord.js').User,
        true,
      );
      if (normalized) {
        callback(normalized);
      }
    });

    client.on('messageReactionRemove', (reaction, user) => {
      if (reaction.message.partial) return;
      if (user.partial) return;
      const normalized = DiscordEventNormalizer.normalizeReaction(
        reaction as import('discord.js').MessageReaction,
        user as import('discord.js').User,
        false,
      );
      if (normalized) {
        callback(normalized);
      }
    });

    client.on('guildMemberAdd', (member) => {
      const normalized = DiscordEventNormalizer.normalizeMemberChange(member, true);
      if (normalized) {
        callback(normalized);
      }
    });

    client.on('guildMemberRemove', (member) => {
      if (member.partial) return;
      const normalized = DiscordEventNormalizer.normalizeMemberChange(
        member as import('discord.js').GuildMember,
        false,
      );
      if (normalized) {
        callback(normalized);
      }
    });
  }
}
