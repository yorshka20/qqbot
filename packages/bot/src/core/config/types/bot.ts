// Bot self configuration

export interface BotSelfConfig {
  selfId: string;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
  // Bot's own nickname/display name as users see it in chat. Injected into the
  // base system prompt so the LLM can recognize when a user is addressing it
  // by name rather than only by @QQ. Optional — leave empty to skip.
  nickname?: string;
}

export interface StaticServerConfig {
  port: number;
  host: string;
  root: string;
}

/**
 * Where the cluster daemon listens and the bearer token its HTTP API expects. Optional: when
 * the daemon runs on this host from the same config tree, `clusterDaemon` already says both.
 */
export interface ClusterClientConfig {
  url: string;
  token: string;
}

export interface FileReadServiceConfig {
  root: string;
  filterPaths: string[];
  filterExtensions: string[];
}
