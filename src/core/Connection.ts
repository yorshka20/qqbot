// Single protocol WebSocket connection management

import { ConnectionError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { EventEmitter } from 'events';
import type { ProtocolConfig } from './Config';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface ConnectionEvents {
  open: () => void;
  close: () => void;
  error: (error: Error) => void;
  message: (data: unknown) => void;
  state: (state: ConnectionState) => void;
}

export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private config: ProtocolConfig;

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

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');

    try {
      // Use Bun native WebSocket with custom headers
      this.ws = new WebSocket(this.config.connection.url, {
        headers: {
          Authorization: `Bearer ${this.config.connection.accessToken}`,
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      this.setState('disconnected');
      const err = error instanceof Error ? error : new Error('Unknown error');
      throw new ConnectionError(
        `Failed to create WebSocket: ${err.message}`,
        this.config.name,
      );
    }
  }

  disconnect(): void {
    this.cancelReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
    this.reconnectAttempts = 0;
  }

  send(data: string): void {
    if (this.state !== 'connected' || !this.ws) {
      throw new ConnectionError('WebSocket is not connected', this.config.name);
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError(
        'WebSocket is not in OPEN state',
        this.config.name,
      );
    }

    try {
      this.ws.send(data);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      throw new ConnectionError(
        `Failed to send message: ${err.message}`,
        this.config.name,
      );
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    // Use Bun native WebSocket event handlers
    this.ws.onopen = () => {
      logger.info(`[Connection] ${this.config.name} connected`);
      this.setState('connected');
      this.reconnectAttempts = 0;
      this.emit('open');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        let message: unknown;
        if (typeof event.data === 'string') {
          message = JSON.parse(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          message = JSON.parse(new TextDecoder().decode(event.data));
        } else {
          // For other types (Blob, etc.), try to use as-is
          message = event.data;
        }
        this.emit('message', message);
      } catch (error) {
        logger.error(
          `[Connection] ${this.config.name} failed to parse message:`,
          error,
        );
      }
    };

    this.ws.onclose = () => {
      logger.info(`[Connection] ${this.config.name} closed`);
      this.setState('disconnected');
      this.emit('close');
      this.handleReconnect();
    };

    this.ws.onerror = (error: Event) => {
      const errorMessage =
        error instanceof ErrorEvent ? error.message : 'WebSocket error';
      const err = new Error(errorMessage);
      logger.error(`[Connection] ${this.config.name} error:`, err);
      this.emit('error', err);
    };
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('state', state);
      logger.debug(
        `[Connection] ${this.config.name} state changed to: ${state}`,
      );
    }
  }

  private handleReconnect(): void {
    if (!this.config.reconnect.enabled) {
      return;
    }

    if (this.reconnectAttempts >= this.config.reconnect.maxRetries) {
      logger.error(
        `[Connection] ${this.config.name} max reconnect attempts reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay();

    logger.info(
      `[Connection] ${this.config.name} reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        logger.error(
          `[Connection] ${this.config.name} reconnect failed:`,
          error,
        );
      });
    }, delay);
  }

  private calculateReconnectDelay(): number {
    const { backoff, initialDelay, maxDelay } = this.config.reconnect;
    let delay = initialDelay;

    if (backoff === 'exponential') {
      delay = initialDelay * Math.pow(2, this.reconnectAttempts - 1);
    } else {
      delay = initialDelay * this.reconnectAttempts;
    }

    return Math.min(delay, maxDelay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
