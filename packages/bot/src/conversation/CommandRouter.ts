// Command Router - routes messages to command or AI processing

import { CommandParser } from '@/command';
import type { ParsedCommand } from '@/command/types';
import type { MessageSegment } from '@/message/types';

/**
 * Command Router
 * Determines if a message is a command and routes accordingly
 */
export class CommandRouter {
  private parser: CommandParser;

  constructor(prefixes: string[] = ['/', '!']) {
    this.parser = new CommandParser(prefixes);
  }

  /**
   * Parse and route message (plain or mixed-content; parser handles both).
   * Returns parsed command if message is a command, null otherwise.
   */
  route(message: string): ParsedCommand | null {
    return this.parser.parse(message);
  }

  /**
   * Parse and route message from segments.
   * Extracts text from segments (only text segments; reply/at/image are skipped) and routes command.
   * Ignoring reply segments is intentional: the quoted message is old and should not trigger a command again.
   */
  routeFromSegments(segments: MessageSegment[]): ParsedCommand | null {
    const text = this.extractTextForCommand(segments);
    return this.parser.parse(text);
  }

  /**
   * Extract text from segments for command parsing.
   * Only text segments are included; reply, at, image, etc. are skipped.
   */
  private extractTextForCommand(segments: MessageSegment[]): string {
    return segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => (segment.type === 'text' ? segment.data.text : ''))
      .join('')
      .trim();
  }

  /**
   * Check if message is a command
   */
  isCommand(message: string): boolean {
    return this.parser.isCommand(message);
  }

  /**
   * Set command prefixes
   */
  setPrefixes(prefixes: string[]): void {
    this.parser.setPrefixes(prefixes);
  }
}
