// Command type definitions

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
  execute(
    args: string[],
    context: CommandContext,
  ): Promise<CommandResult> | CommandResult;
}

/**
 * Command execution context
 */
export interface CommandContext {
  userId: number;
  groupId?: number;
  messageType: 'private' | 'group';
  rawMessage: string;
  metadata?: Record<string, unknown>;
}

/**
 * Command registration info
 */
export interface CommandRegistration {
  handler: CommandHandler;
  priority: number; // Higher priority = executed first
  pluginName?: string; // If registered by plugin
}
