// Command System - handles command processing

import type { CommandManager } from '@/command/CommandManager';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/plugins/HookManager';
import { getExtensionHookPriority } from '@/plugins/hooks/HookPriority';
import type { HookContext } from '@/plugins/hooks/types';

/**
 * Command System
 * Handles command detection and execution
 */
export class CommandSystem implements System {
  readonly name = 'command';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS;
  readonly priority = 100; // High priority, executes early in PROCESS stage

  constructor(
    private commandManager: CommandManager,
    private hookManager: HookManager,
  ) {}

  async execute(context: HookContext): Promise<boolean> {
    const command = context.command;
    if (!command) {
      return true; // Not a command, skip
    }

    // Hook: onCommandDetected
    await this.hookManager.execute('onCommandDetected', context);

    // Execute command
    const commandResult = await this.commandManager.execute(
      command,
      {
        userId: context.message.userId,
        groupId: context.message.groupId,
        messageType: context.message.messageType,
        rawMessage: context.message.message,
        metadata: {
          senderRole: context.message.sender?.role,
        },
      },
      this.hookManager,
      context,
    );

    // Update hook context
    context.result = commandResult;

    // Hook: onCommandExecuted
    await this.hookManager.execute('onCommandExecuted', context);

    // Set reply in metadata
    if (commandResult.success && commandResult.message) {
      context.metadata.set('reply', commandResult.message);
    }

    return true;
  }

  getExtensionHooks() {
    return [
      {
        hookName: 'onCommandDetected',
        handler: () => true,
        priority: getExtensionHookPriority('onCommandDetected', 'DEFAULT'),
      },
      {
        hookName: 'onCommandExecuted',
        handler: () => true,
        priority: getExtensionHookPriority('onCommandExecuted', 'DEFAULT'),
      },
    ];
  }
}
