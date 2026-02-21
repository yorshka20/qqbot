// Protocol configuration types

import type { APIStrategy, BackoffStrategy, DeduplicationStrategy } from './types';

export type ProtocolName = 'milky' | 'onebot11' | 'satori';

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

export interface ProtocolConfig {
  name: ProtocolName;
  enabled: boolean;
  priority: number;
  // if true, will not send real message, just log.
  mockSendMessage: boolean;
  connection: ProtocolConnectionConfig;
  reconnect: ReconnectConfig;
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
