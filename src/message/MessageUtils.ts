// Message utility functions - centralized message analysis helpers

import { CommandParser } from '@/command/CommandParser';
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
   * Supports multiple protocols: Milky (mention) and OneBot11 (at)
   * Note: In Milky protocol, @0 (user_id=0) typically means @bot itself
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
      } else if (segment.type === 'at') {
        // Handle OneBot11 protocol (at type)
        const qq = segment.data.qq;
        if (typeof qq === 'number' || typeof qq === 'string') {
          atUserId = qq;
        }
      }

      // atUserId could be 0
      if (atUserId !== undefined) {
        const atUserIdNum = typeof atUserId === 'string' ? parseInt(atUserId, 10) : atUserId;
        if (!isNaN(atUserIdNum)) {
          // In Milky protocol, @0 (user_id=0) typically means @bot itself
          // Also check if the atUserId matches botSelfId
          if (atUserIdNum === 0 || atUserIdNum === botSelfIdNum) {
            return true;
          }
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
}
