// Message utility functions - centralized message analysis helpers

import { CommandParser } from '@/command/CommandParser';
import type { BotSelfConfig } from '@/core/config/types/bot';
import type { NormalizedMessageEvent } from '@/events/types';

/**
 * Message utility functions
 * Centralized helpers for message analysis (command detection, @bot detection, etc.)
 */
export class MessageUtils {
  private static commandParser: CommandParser | null = null;

  /**
   * Initialize command parser with prefixes
   * Should be called during system initialization
   */
  static initialize(prefixes: string[] = ['/', '!']): void {
    MessageUtils.commandParser = new CommandParser(prefixes);
  }

  /**
   * Check if message is a command
   * @param message - Message text to check
   * @returns true if message is a command
   */
  static isCommand(message: string): boolean {
    if (!MessageUtils.commandParser) {
      // Fallback: create parser with default prefixes if not initialized
      MessageUtils.commandParser = new CommandParser(['/', '!']);
    }
    return MessageUtils.commandParser.isCommand(message);
  }

  /**
   * Check if message is @bot itself
   * Supports multiple protocols: Milky (mention), OneBot11 (at), and Discord (at with string IDs)
   * Note: In Milky protocol, @0 (user_id=0) typically means @bot itself
   *
   * Uses string comparison to support Discord snowflake IDs that exceed Number.MAX_SAFE_INTEGER.
   *
   * @param message - Message with segments
   * @param botSelfId - Bot's self ID
   * @returns true if message is @bot
   */
  static isAtBot(
    message: {
      segments?: Array<{ type: string; data?: Record<string, unknown> }>;
    },
    botSelfId?: string | null,
  ): boolean {
    if (!botSelfId || botSelfId === '') {
      return false;
    }

    const botSelfIdStr = String(botSelfId);

    // Check if message has segments
    if (!message.segments || message.segments.length === 0) {
      return false;
    }

    // Check if any segment is an 'at' or 'mention' segment targeting bot selfId
    for (const segment of message.segments) {
      if (!segment.data) {
        continue;
      }

      let atUserId: string | undefined;

      // Handle Milky protocol (mention type)
      if (segment.type === 'mention') {
        const userId = segment.data.user_id;
        if (userId !== undefined && userId !== null) {
          atUserId = String(userId);
        }
      } else if (segment.type === 'at') {
        // Handle OneBot11 / Discord protocol (at type)
        const qq = segment.data.qq;
        if (qq !== undefined && qq !== null) {
          atUserId = String(qq);
        }
      }

      if (atUserId !== undefined) {
        // In Milky protocol, @0 (user_id=0) typically means @bot itself
        if (atUserId === '0') {
          return true;
        }
        // String comparison: works for all protocols including Discord snowflakes
        if (atUserId === botSelfIdStr) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if message is from bot itself
   * @param message - Message event
   * @param botSelfId - Bot's self ID
   * @returns true if message is from bot itself
   */
  static isFromBot(message: NormalizedMessageEvent, botSelfId?: string | null): boolean {
    if (!botSelfId || !message.userId) {
      return false;
    }
    return message.userId.toString() === botSelfId.toString();
  }

  /**
   * Check if user is bot owner
   * @param userId - User ID to check
   * @param botConfig - Bot configuration (bot section)
   * @returns true if user is bot owner
   */
  static isOwner(userId: number | string | undefined, botConfig?: BotSelfConfig | null): boolean {
    if (!userId || !botConfig) {
      return false;
    }

    const userIdStr = userId.toString();
    return botConfig.owner ? userIdStr === botConfig.owner.toString() : false;
  }

  /**
   * Check if user is bot admin (owner or in admins list)
   * @param userId - User ID to check
   * @param botConfig - Bot configuration (bot section)
   * @returns true if user is admin or owner
   */
  static isAdmin(userId: number | string | undefined, botConfig?: BotSelfConfig | null): boolean {
    if (!userId || !botConfig) {
      return false;
    }

    // Check if user is owner
    if (MessageUtils.isOwner(userId, botConfig)) {
      return true;
    }

    // Check if user is in admins list
    const userIdStr = userId.toString();
    if (botConfig.admins && Array.isArray(botConfig.admins)) {
      return botConfig.admins.some((adminId: string) => adminId.toString() === userIdStr);
    }

    return false;
  }
}
