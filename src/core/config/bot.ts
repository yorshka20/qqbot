// Bot self configuration

export interface BotSelfConfig {
  selfId: string;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
}

export interface StaticServerConfig {
  port: number;
  host: string;
  root: string;
}
