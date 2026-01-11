// Command Router - routes messages to command or AI processing

import { CommandParser } from '@/command';
import type { ParsedCommand } from '@/command/types';

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
