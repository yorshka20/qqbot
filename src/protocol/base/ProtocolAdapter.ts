// Abstract base class for protocol adapters
// Transport-agnostic — only holds connection reference, config, and abstract declarations.

import { EventEmitter } from 'events';
import type { APIContext } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import type { Connection } from '@/core/connection';
import type { BaseEvent } from './types';

export abstract class ProtocolAdapter extends EventEmitter {
  protected connection: Connection;
  protected config: ProtocolConfig;

  constructor(config: ProtocolConfig, connection: Connection) {
    super();
    this.config = config;
    this.connection = connection;
    this.setupConnectionEvents();
  }

  abstract normalizeEvent(rawEvent: unknown): BaseEvent | null;
  abstract getProtocolName(): ProtocolName;

  async connect(): Promise<void> {
    await this.connection.connect();
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  isConnected(): boolean {
    return this.connection.getState() === 'connected';
  }

  abstract sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse>;

  abstract onEvent(callback: (event: BaseEvent) => void): void;

  private setupConnectionEvents(): void {
    this.connection.on('open', () => {
      this.emit('open');
    });

    this.connection.on('close', () => {
      this.emit('close');
    });

    this.connection.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }
}
