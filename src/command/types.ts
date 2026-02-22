// Command type definitions

import type { ConversationContext } from '@/context/types';
import { ProtocolName } from '@/core/config';
import { NormalizedMessageEvent } from '@/events/types';
import { MessageSegment } from '@/message/types';

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
  segments?: MessageSegment[]; // Message segments (images, audio, text, etc.) - required if success is true
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
   * Required permission levels (user must have at least one). If omitted, allow all users.
   */
  permissions?: PermissionLevel[];

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
  senderRole: string;
  // System execution flag - if true, skip permission checks (for bot/system-initiated commands)
  isSystemExecution?: boolean;
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
  // Conversation context from HookContext
  conversationContext: ConversationContext;
  // Original message event (optional, for accessing segments, etc.)
  originalMessage?: NormalizedMessageEvent;
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
