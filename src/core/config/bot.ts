// Bot self configuration

import type { LogLevel } from './types';

export interface BotSelfConfig {
  selfId: string;
  logLevel: LogLevel;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
}
