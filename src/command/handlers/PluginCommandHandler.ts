// Plugin command handler wrapper

import type { CommandHandler, CommandContext, CommandResult } from '../types';
import type { PluginContext } from '@/plugins/types';

/**
 * Wrapper for plugin-provided command handlers
 * This allows plugins to register commands through the plugin context
 */
export class PluginCommandHandler implements CommandHandler {
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
  ) {}

  execute(args: string[], context: CommandContext): Promise<CommandResult> | CommandResult {
    return this.executeFn(args, context, this.pluginContext);
  }
}
