// Command type definitions

import { ProtocolName } from '@/core/config';

/**
 * Parsed command structure
 */
export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string; // Original command string
  prefix: string; // Command prefix used (/ or !)
}

/**
 * Command execution result
 */
export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Command handler interface
 */
export interface CommandHandler {
  /**
   * Command name (without prefix)
   */
  name: string;

  /**
   * Command description
   */
  description?: string;

  /**
   * Command usage example
   */
  usage?: string;

  /**
   * Execute command
   */
  execute(args: string[], context: CommandContext): Promise<CommandResult> | CommandResult;
}

/**
 * CommandContext Metadata interface
 * Defines all possible metadata keys and their types
 */
export interface CommandContextMetadata {
  // Protocol information
  protocol: ProtocolName;
  // Command metadata
  senderRole?: string;
}


/**
 * Command execution context
 */
export interface CommandContext {
  userId: number;
  groupId?: number;
  messageType: 'private' | 'group';
  rawMessage: string;
  // Message scene from protocol (e.g., 'private', 'group', 'temp' for temporary session)
  messageScene: string;
  metadata: CommandContextMetadata;
}

/**
 * Permission levels for command access control
 */
export type PermissionLevel = 'user' | 'group_admin' | 'group_owner' | 'admin' | 'owner';

/**
 * Command registration info
 */
export interface CommandRegistration {
  handler: CommandHandler;
  handlerClass?: new (...args: any[]) => CommandHandler; // Class reference for lazy instantiation
  pluginName?: string; // If registered by plugin
  permissions?: PermissionLevel[]; // Required permissions
  aliases?: string[]; // Command aliases
  enabled?: boolean; // Whether command is enabled
}
