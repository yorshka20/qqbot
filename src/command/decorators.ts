// Command decorator for automatic registration

import type { CommandHandler } from './types';

/**
 * Permission levels for command access control
 */
export type PermissionLevel =
  | 'user'
  | 'group_admin'
  | 'group_owner'
  | 'admin'
  | 'owner';

/**
 * Command decorator options
 * Dependencies are now handled automatically by TSyringe using @injectable() and @inject()
 */
export interface CommandOptions {
  /**
   * Command name (required)
   */
  name: string;

  /**
   * Command description
   */
  description?: string;

  /**
   * Usage example/format
   */
  usage?: string;

  /**
   * Permission requirements (array of permission levels)
   * User must have at least one of these permissions
   */
  permissions?: PermissionLevel[];

  /**
   * Command aliases
   */
  aliases?: string[];

  /**
   * Whether command is enabled (default: true)
   */
  enabled?: boolean;
}

/**
 * Command metadata stored on class
 */
export interface CommandMetadata extends CommandOptions {
  handlerClass: new (...args: any[]) => CommandHandler;
}

// Symbol for storing command metadata on class
const COMMAND_METADATA_KEY = Symbol('command:metadata');

// Static registry for all decorated commands
const commandRegistry: CommandMetadata[] = [];

/**
 * Command decorator
 * Automatically registers command handlers when class is loaded
 *
 * Note: Dependencies should be injected using TSyringe's @injectable() and @inject() decorators
 *
 * @param options - Command options (name, description, permissions, etc.)
 */
export function Command(options: CommandOptions) {
  return function <T extends new (...args: any[]) => CommandHandler>(
    target: T,
  ): T {
    // Store metadata on class
    const metadata: CommandMetadata = {
      ...options,
      handlerClass: target,
    };

    // Store metadata using Symbol
    (target as any)[COMMAND_METADATA_KEY] = metadata;

    // Add to static registry
    commandRegistry.push(metadata);

    return target;
  };
}

/**
 * Get command metadata from class
 */
export function getCommandMetadata(
  handlerClass: new (...args: any[]) => CommandHandler,
): CommandMetadata | undefined {
  return (handlerClass as any)[COMMAND_METADATA_KEY];
}

/**
 * Get all registered command metadata
 */
export function getAllCommandMetadata(): CommandMetadata[] {
  return [...commandRegistry];
}
