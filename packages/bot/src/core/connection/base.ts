// Abstract base class for protocol connections
// Provides state management and event declarations only — no transport details.

import { EventEmitter } from 'events';
import type { ProtocolConfig } from '../config';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionEvents {
  open: () => void;
  close: () => void;
  error: (error: Error) => void;
  message: (data: unknown) => void;
  state: (state: ConnectionState) => void;
}

export abstract class Connection extends EventEmitter {
  protected state: ConnectionState = 'disconnected';
  protected config: ProtocolConfig;

  constructor(config: ProtocolConfig) {
    super();
    this.config = config;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getProtocolName(): string {
    return this.config.name;
  }

  protected setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('state', state);
    }
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;

  /** No-op by default; WebSocketConnection overrides with actual ping. */
  ping(_data?: string | ArrayBuffer): void {
    // Default no-op
  }
}
