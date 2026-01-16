// Command System - handles command processing

import type { CommandManager } from '@/command/CommandManager';
import { setReply } from '@/context/HookContextHelpers';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';

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

  enabled(): boolean {
    return true;
  }

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

    // Set reply using helper function
    if (commandResult.success && commandResult.message) {
      setReply(context, commandResult.message, 'command');
    }

    return true;
  }

  /**
   * Declare extension hooks that plugins can subscribe to
   * These hooks are declared without handlers - plugins can register their own handlers
   * The priority is used as default when plugins register handlers without specifying priority
   */
  getExtensionHooks() {
    return [
      {
        hookName: 'onCommandDetected',
        priority: getHookPriority('onCommandDetected', 'NORMAL'),
      },
      {
        hookName: 'onCommandExecuted',
        priority: getHookPriority('onCommandExecuted', 'NORMAL'),
      },
    ];
  }
}
