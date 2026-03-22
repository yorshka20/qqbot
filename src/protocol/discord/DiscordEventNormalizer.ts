// Discord event normalizer - converts discord.js events to normalized BaseEvent format

import type { GuildMember, Message as DiscordMessage, MessageReaction, PartialMessage, User } from 'discord.js';
import type { BaseEvent } from '../base/types';
import type { NormalizedDiscordMessageEvent, NormalizedDiscordMetaEvent, NormalizedDiscordNoticeEvent } from './types';
import { discordMessageToSegments } from './DiscordSegmentConverter';

export class DiscordEventNormalizer {
  /**
   * Normalize a discord.js messageCreate event to NormalizedDiscordMessageEvent.
   */
  static normalizeMessageCreate(message: DiscordMessage): NormalizedDiscordMessageEvent | null {
    // Ignore bot messages to prevent loops
    if (message.author.bot) {
      return null;
    }

    const isDM = !message.guild;
    const segments = discordMessageToSegments(message);
    const textContent =
      segments
        .filter((s) => s.type === 'text')
        .map((s) => s.data.text ?? '')
        .join('') || message.content;

    return {
      id: message.id,
      type: 'message',
      timestamp: message.createdTimestamp,
      protocol: 'discord',
      messageType: isDM ? 'private' : 'group',
      userId: message.author.id,
      groupId: isDM ? undefined : message.channelId,
      message: textContent,
      rawMessage: message.content,
      messageId: message.id,
      segments,
      groupName: isDM ? undefined : (message.guild?.name ?? undefined),
      sender: {
        userId: message.author.id,
        nickname: message.author.displayName ?? message.author.username,
        card: message.member?.nickname ?? undefined,
        role: message.member?.roles?.highest?.name ?? undefined,
      },
    };
  }

  /**
   * Normalize a discord.js messageDelete event.
   */
  static normalizeMessageDelete(message: DiscordMessage | PartialMessage): NormalizedDiscordNoticeEvent | null {
    return {
      id: message.id ?? `delete_${Date.now()}`,
      type: 'notice',
      timestamp: Date.now(),
      protocol: 'discord',
      noticeType: 'message_delete',
      groupId: message.guild ? message.channelId : undefined,
      messageType: message.guild ? 'group' : 'private',
    };
  }

  /**
   * Normalize a discord.js messageReactionAdd/Remove event.
   */
  static normalizeReaction(reaction: MessageReaction, user: User, isAdd: boolean): NormalizedDiscordNoticeEvent | null {
    return {
      id: `reaction_${reaction.message.id}_${user.id}_${Date.now()}`,
      type: 'notice',
      timestamp: Date.now(),
      protocol: 'discord',
      noticeType: 'group_message_reaction',
      groupId: reaction.message.guild ? reaction.message.channelId : undefined,
      messageType: 'group',
      userId: user.id,
      isAdd,
    };
  }

  /**
   * Normalize a discord.js guildMemberAdd/Remove event.
   */
  static normalizeMemberChange(member: GuildMember, isJoin: boolean): NormalizedDiscordNoticeEvent | null {
    return {
      id: `member_${member.id}_${Date.now()}`,
      type: 'notice',
      timestamp: Date.now(),
      protocol: 'discord',
      noticeType: isJoin ? 'group_member_increase' : 'group_member_decrease',
      userId: member.id,
    };
  }

  /**
   * Normalize the discord.js 'ready' event.
   */
  static normalizeReady(botUserId: string): NormalizedDiscordMetaEvent {
    return {
      id: `ready_${Date.now()}`,
      type: 'meta_event',
      timestamp: Date.now(),
      protocol: 'discord',
      metaEventType: 'lifecycle',
      subType: 'connect',
      selfId: botUserId,
    };
  }

  /**
   * Generic normalizer entry point (used by the adapter's normalizeEvent override).
   * Discord events don't arrive as raw JSON like WS protocols, so this is a no-op placeholder
   * required by the base class contract. Actual normalization is done via the static methods above.
   */
  static normalizeEvent(_rawEvent: unknown): BaseEvent | null {
    return null;
  }
}
