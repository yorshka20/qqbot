// Command Builder - programmatically build ParsedCommand objects

import type { ParsedCommand } from './types';

/**
 * Options for building a command
 */
export interface CommandBuildOptions {
  /**
   * Command prefix to use (default: '/')
   */
  prefix?: string;
  /**
   * Whether to escape arguments with spaces (default: true)
   */
  escapeArgs?: boolean;
}

/**
 * Command Builder
 * Provides a clean API for programmatically building ParsedCommand objects
 */
export class CommandBuilder {
  private static readonly DEFAULT_PREFIX = '/';
  private static readonly DEFAULT_PREFIXES = ['/', '!'];

  /**
   * Build a ParsedCommand from command name and arguments
   *
   * @param name - Command name (without prefix)
   * @param args - Command arguments
   * @param options - Build options
   * @returns ParsedCommand object
   *
   * @example
   * ```typescript
   * // Simple usage
   * const cmd = CommandBuilder.build('tts', ['hello world']);
   *
   * // With custom prefix
   * const cmd = CommandBuilder.build('tts', ['hello'], { prefix: '!' });
   *
   * // Without escaping (for simple args)
   * const cmd = CommandBuilder.build('help', [], { escapeArgs: false });
   * ```
   */
  static build(name: string, args: string[] = [], options: CommandBuildOptions = {}): ParsedCommand {
    // Validate command name
    if (!name || name.trim().length === 0) {
      throw new Error('Command name cannot be empty');
    }

    // Normalize command name (lowercase, trimmed)
    const normalizedName = name.trim().toLowerCase();

    // Get prefix (use provided or default)
    const prefix = options.prefix ?? CommandBuilder.DEFAULT_PREFIX;

    // Build raw command string
    const raw = CommandBuilder.buildRawCommand(prefix, normalizedName, args, options.escapeArgs ?? true);

    return {
      name: normalizedName,
      args: [...args], // Create a copy to avoid mutation
      raw,
      prefix,
    };
  }

  /**
   * Build raw command string from prefix, name, and args
   *
   * @param prefix - Command prefix
   * @param name - Command name
   * @param args - Command arguments
   * @param escapeArgs - Whether to escape args with spaces
   * @returns Raw command string
   */
  private static buildRawCommand(prefix: string, name: string, args: string[], escapeArgs: boolean): string {
    // Start with prefix and command name
    let raw = `${prefix}${name}`;

    // Add arguments
    if (args.length > 0) {
      const processedArgs = args.map((arg) => {
        if (!escapeArgs) {
          return arg;
        }
        // Escape argument if it contains spaces or special characters
        return CommandBuilder.escapeArgument(arg);
      });

      raw += ` ${processedArgs.join(' ')}`;
    }

    return raw;
  }

  /**
   * Escape an argument if it contains spaces or special characters
   * Wraps in double quotes and escapes internal quotes
   *
   * @param arg - Argument to escape
   * @returns Escaped argument
   */
  private static escapeArgument(arg: string): string {
    // If argument contains spaces, quotes, or special characters, wrap in quotes
    if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('\n') || arg.includes('\t')) {
      // Escape internal double quotes
      const escaped = arg.replace(/"/g, '\\"');
      return `"${escaped}"`;
    }

    return arg;
  }

  /**
   * Get default command prefix
   */
  static getDefaultPrefix(): string {
    return CommandBuilder.DEFAULT_PREFIX;
  }

  /**
   * Get all default command prefixes
   */
  static getDefaultPrefixes(): string[] {
    return [...CommandBuilder.DEFAULT_PREFIXES];
  }
}
