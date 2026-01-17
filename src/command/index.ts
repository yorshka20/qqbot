// Command module exports

export { CommandBuilder, type CommandBuildOptions } from './CommandBuilder';
export { CommandManager, type PermissionChecker } from './CommandManager';
export { CommandParser } from './CommandParser';
export { Command, getAllCommandMetadata, getCommandMetadata } from './decorators';
export { HelpCommand, PingCommand, StatusCommand } from './handlers/BuiltinCommandHandler';
export { DefaultPermissionChecker } from './PermissionChecker';
export type {
  CommandContext,
  CommandHandler,
  CommandRegistration,
  CommandResult,
  ParsedCommand,
  PermissionLevel
} from './types';

