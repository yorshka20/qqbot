// Protocol configuration types

import type { APIStrategy, BackoffStrategy, DeduplicationStrategy } from './const';

export type ProtocolName = 'milky' | 'onebot11' | 'satori' | 'discord';

export type ConnectionType = 'websocket' | 'discord';

export interface ProtocolConnectionConfig {
  url: string;
  apiUrl: string;
  accessToken: string;
}

export interface ReconnectConfig {
  enabled: boolean;
  maxRetries: number;
  backoff: BackoffStrategy;
  initialDelay: number;
  maxDelay: number;
}

export interface DiscordConfig {
  intents?: string[];
  guildId?: string;
}

export interface ProtocolConfig {
  name: ProtocolName;
  enabled: boolean;
  priority: number;
  /** Transport type: 'websocket' or 'discord' (discord.js managed). */
  connectionType: ConnectionType;
  // if true, will not send real message, just log.
  mockSendMessage: boolean;
  connection: ProtocolConnectionConfig;
  reconnect: ReconnectConfig;
  discord?: DiscordConfig;
  // Per-protocol owner override (user ID on this protocol that maps to the bot owner)
  owner?: string;
  // Per-protocol admin overrides (user IDs on this protocol that have admin permission)
  admins?: string[];
}

export interface APIConfig {
  strategy: APIStrategy;
  preferredProtocol?: ProtocolName;
}

export interface EventConfig {
  deduplication: EventDeduplicationConfig;
}

export interface EventDeduplicationConfig {
  enabled: boolean;
  strategy: DeduplicationStrategy;
  window: number;
}
