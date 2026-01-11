// Command parser - parses command format from message

import type { ParsedCommand } from './types';
import { logger } from '@/utils/logger';

export class CommandParser {
  constructor(private prefixes: string[] = ['/', '!']) {}

  /**
   * Parse command from message
   * Returns null if message is not a command
   */
  parse(message: string): ParsedCommand | null {
    const trimmed = message.trim();

    // Find matching prefix
    let prefix: string | null = null;
    for (const p of this.prefixes) {
      if (trimmed.startsWith(p)) {
        prefix = p;
        break;
      }
    }

    if (!prefix) {
      return null;
    }

    // Extract command and args
    const withoutPrefix = trimmed.slice(prefix.length).trim();
    if (!withoutPrefix) {
      return null; // Empty command
    }

    // Split by whitespace
    const parts = withoutPrefix.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    logger.debug(`[CommandParser] Parsed command: ${name} with args: ${args.join(', ')}`);

    return {
      name,
      args,
      raw: trimmed,
      prefix,
    };
  }

  /**
   * Check if message is a command
   */
  isCommand(message: string): boolean {
    return this.parse(message) !== null;
  }

  /**
   * Set command prefixes
   */
  setPrefixes(prefixes: string[]): void {
    this.prefixes = prefixes;
  }
}
