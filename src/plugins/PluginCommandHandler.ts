// Plugin Command Handler Adapter
// This is NOT a command handler implementation, but an adapter/wrapper for plugins to register commands
//
// Purpose:
// - Allows plugins to register custom commands to CommandManager
// - Wraps plugin-provided execute functions into standard CommandHandler interface
// - Provides pluginContext access to command execution functions
//
// Usage:
//   const handler = new PluginCommandHandler(
//     'mycommand',
//     'Description',
//     '/mycommand [args]',
//     async (args, context, pluginContext) => { ... },
//     pluginContext
//   );
//   commandManager.register(handler, pluginName);
//
// Note: This is different from command handlers in src/command/handlers/
// - Handlers in src/command/handlers/ are actual command implementations (e.g., TTSCommandHandler)
// - PluginCommandHandler is an adapter that allows plugins to register commands dynamically

import type { CommandContext, CommandHandler, CommandResult, PermissionLevel } from '@/command/types';
import type { PluginContext } from './types';

/**
 * Plugin Command Handler Adapter
 *
 * This adapter allows plugins to register custom commands to the CommandManager.
 * It wraps plugin-provided execute functions into the standard CommandHandler interface.
 *
 * This is NOT a command handler implementation itself, but rather a bridge between
 * the plugin system and the command system.
 *
 * @example
 * ```typescript
 * // In a plugin's onEnable() method:
 * const handler = new PluginCommandHandler(
 *   'mycommand',
 *   'My command description',
 *   '/mycommand [args]',
 *   async (args: string[], context: CommandContext, pluginContext: PluginContext) => {
 *     // Command implementation
 *     return { success: true, segments: [...] };
 *   },
 *   this.context,
 *   ['admin']  // optional: required permissions
 * );
 * this.commandManager.register(handler, this.name);
 * ```
 */
export class PluginCommandHandler implements CommandHandler {
  /**
   * Create a plugin command handler adapter
   *
   * @param name - Command name (e.g., 'cmd', 'mycommand')
   * @param description - Command description
   * @param usage - Command usage string
   * @param executeFn - Command execution function that receives args, context, and pluginContext
   * @param pluginContext - Plugin context (API, events, bot config)
   * @param permissions - Optional required permission levels (e.g. ['admin'], ['group_admin', 'group_owner'])
   */
  constructor(
    public name: string,
    public description: string | undefined,
    public usage: string | undefined,
    private executeFn: (
      args: string[],
      context: CommandContext,
      pluginContext: PluginContext,
    ) => Promise<CommandResult> | CommandResult,
    private pluginContext: PluginContext,
    public permissions?: PermissionLevel[],
  ) { }

  /**
   * Execute the command
   * This method is called by CommandManager when the command is invoked
   *
   * @param args - Command arguments
   * @param context - Command execution context
   * @returns Command execution result
   */
  execute(args: string[], context: CommandContext): Promise<CommandResult> | CommandResult {
    return this.executeFn(args, context, this.pluginContext);
  }
}
