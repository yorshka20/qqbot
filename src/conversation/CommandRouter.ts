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
   * Parse and route message
   * Returns parsed command if message is a command, null otherwise
   */
  route(message: string): ParsedCommand | null {
    return this.parser.parse(message);
  }

  /**
   * Parse and route message from segments
   * Extracts text from segments (skipping reply and at segments) and routes command
   * This is useful when messages contain reply segments that should be ignored for command detection
   */
  routeFromSegments(segments: MessageSegment[]): ParsedCommand | null {
    // Extract text from segments, skipping reply and at segments
    const text = this.extractTextForCommand(segments);
    return this.parser.parse(text);
  }

  /**
   * Extract text from segments for command parsing
   * Skips reply and at segments, only includes text segments
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
