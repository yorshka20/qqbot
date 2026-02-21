// Command parser - parses command format from message

import type { ParsedCommand } from './types';
import { logger } from '@/utils/logger';

export class CommandParser {
  constructor(private prefixes: string[] = ['/', '!']) {}

  /**
   * Parse command from message.
   * Handles both plain command (e.g. "/i2v prompt") and mixed-content (e.g. "[Image:...]\n/i2v prompt"):
   * tries (1) whole message, (2) each line, (3) substring from first command prefix to end.
   * Returns null if message is not a command.
   */
  parse(message: string): ParsedCommand | null {
    const result = this.parseOne(message.trim());
    if (result) {
      return result;
    }
    // Try each line (handles "[Image:...]\n/i2v prompt")
    const lines = message.split(/\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const lineResult = this.parseOne(trimmed);
      if (lineResult) {
        return lineResult;
      }
    }
    // Try from first command prefix to end (handles "[Image:...]/i2v prompt" with no newline)
    for (const p of this.prefixes) {
      const idx = message.indexOf(p);
      if (idx !== -1) {
        const suffixResult = this.parseOne(message.slice(idx).trim());
        if (suffixResult) {
          return suffixResult;
        }
      }
    }
    return null;
  }

  /**
   * Parse a single candidate string that must start with a command prefix.
   * Returns null if not a command.
   */
  private parseOne(trimmed: string): ParsedCommand | null {
    if (!trimmed) {
      return null;
    }
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
    const withoutPrefix = trimmed.slice(prefix.length).trim();
    if (!withoutPrefix) {
      return null;
    }
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
