// Multi-protocol connection management

import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';
import type { Config, ProtocolConfig } from '../config';
import type { Connection } from './base';

export interface ConnectionManagerEvents {
  connectionOpen: (protocol: string, connection: Connection) => void;
  connectionClose: (protocol: string, connection: Connection) => void;
  connectionError: (protocol: string, error: Error) => void;
  allConnected: () => void;
  allDisconnected: () => void;
}

/** Typed event overloads for ConnectionManager (avoids unsafe class/interface merge). */
export interface ConnectionManagerEventOverloads {
  on<U extends keyof ConnectionManagerEvents>(event: U, listener: ConnectionManagerEvents[U]): this;
  emit<U extends keyof ConnectionManagerEvents>(event: U, ...args: Parameters<ConnectionManagerEvents[U]>): boolean;
}

/** Registry of Connection subclass constructors keyed by protocol name. */
const connectionRegistry = new Map<string, new (config: ProtocolConfig) => Connection>();

/**
 * Register a custom Connection subclass for a protocol.
 * Must be called before ConnectionManager.connectAll().
 */
export function registerConnectionClass(protocolName: string, ctor: new (config: ProtocolConfig) => Connection): void {
  connectionRegistry.set(protocolName, ctor);
}

export class ConnectionManager extends EventEmitter implements ConnectionManagerEventOverloads {
  private connections = new Map<string, Connection>();
  private config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  async connectAll(): Promise<void> {
    const enabledProtocols = this.config.getEnabledProtocols();
    logger.info(`[ConnectionManager] Connecting to ${enabledProtocols.length} protocol(s)`);

    const connectPromises = enabledProtocols.map((protocolConfig) => {
      return this.connectProtocol(protocolConfig);
    });

    await Promise.allSettled(connectPromises);
  }

  async connectProtocol(protocolConfig: ProtocolConfig): Promise<void> {
    // Use registered Connection subclass — all protocols must be explicitly registered.
    const ConnectionCtor = connectionRegistry.get(protocolConfig.name);
    if (!ConnectionCtor) {
      throw new Error(
        `No Connection class registered for protocol "${protocolConfig.name}". Call registerConnectionClass() before connectAll().`,
      );
    }
    const connection = new ConnectionCtor(protocolConfig);

    // Set up connection event handlers
    connection.on('open', () => {
      logger.info(`[ConnectionManager] Protocol ${protocolConfig.name} connected`);
      this.emit('connectionOpen', protocolConfig.name, connection);
      this.checkAllConnected();
    });

    connection.on('close', () => {
      logger.info(`[ConnectionManager] Protocol ${protocolConfig.name} closed`);
      this.emit('connectionClose', protocolConfig.name, connection);
      this.checkAllDisconnected();
    });

    connection.on('error', (error: Error) => {
      logger.error(`[ConnectionManager] Protocol ${protocolConfig.name} error:`, error);
      this.emit('connectionError', protocolConfig.name, error);
    });

    this.connections.set(protocolConfig.name, connection);

    try {
      await connection.connect();
    } catch (error) {
      logger.error(`[ConnectionManager] Failed to connect ${protocolConfig.name}:`, error);
      throw error;
    }
  }

  disconnectAll(): void {
    logger.info('[ConnectionManager] Disconnecting all protocols');
    for (const [name, connection] of this.connections) {
      logger.info(`[ConnectionManager] Disconnecting ${name}`);
      connection.disconnect();
    }
    this.connections.clear();
  }

  getConnection(protocolName: string): Connection | undefined {
    return this.connections.get(protocolName);
  }

  getConnections(): Map<string, Connection> {
    return this.connections;
  }

  getConnectedProtocols(): string[] {
    const connected: string[] = [];
    for (const [name, connection] of this.connections) {
      if (connection.getState() === 'connected') {
        connected.push(name);
      }
    }
    return connected;
  }

  isAllConnected(): boolean {
    const enabledProtocols = this.config.getEnabledProtocols();
    return enabledProtocols.every((protocol) => {
      const connection = this.connections.get(protocol.name);
      return connection?.getState() === 'connected';
    });
  }

  private checkAllConnected(): void {
    if (this.isAllConnected()) {
      logger.info('[ConnectionManager] All protocols connected');
      this.emit('allConnected');
    }
  }

  private checkAllDisconnected(): void {
    const connected = this.getConnectedProtocols();
    if (connected.length === 0) {
      logger.info('[ConnectionManager] All protocols disconnected');
      this.emit('allDisconnected');
    }
  }
}
