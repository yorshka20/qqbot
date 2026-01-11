// Base protocol adapter abstract class

import type { ProtocolConfig } from '@/core/Config';
import { Connection } from '@/core/Connection';
import { EventEmitter } from 'events';
import type { BaseAPIRequest, BaseAPIResponse, BaseEvent } from './types';

export abstract class ProtocolAdapter extends EventEmitter {
  protected connection: Connection;
  protected config: ProtocolConfig;
  protected pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestIdCounter = 0;

  constructor(config: ProtocolConfig, connection: Connection) {
    super();
    this.config = config;
    this.connection = connection;
    this.setupConnectionEvents();
  }

  abstract normalizeEvent(rawEvent: unknown): BaseEvent | null;
  abstract getProtocolName(): string;

  async connect(): Promise<void> {
    await this.connection.connect();
  }

  disconnect(): void {
    this.connection.disconnect();
    // Clear all pending requests
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Connection closed'));
    });
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.connection.getState() === 'connected';
  }

  async sendAPI<TResponse = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    timeout = 10000,
  ): Promise<TResponse> {
    if (!this.isConnected()) {
      throw new Error(`Protocol ${this.getProtocolName()} is not connected`);
    }

    const echo = this.generateEcho();
    const request: BaseAPIRequest = {
      action,
      params,
      echo,
    };

    return new Promise<TResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`API request timeout: ${action}`));
      }, timeout);

      this.pendingRequests.set(echo, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.connection.send(JSON.stringify(request));
      } catch (error) {
        this.pendingRequests.delete(echo);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  onEvent(callback: (event: BaseEvent) => void): void {
    this.connection.on('message', (rawMessage: unknown) => {
      // Try to handle as API response first
      if (this.handleAPIResponse(rawMessage)) {
        return;
      }

      // Handle as event
      const normalizedEvent = this.normalizeEvent(rawMessage);
      if (normalizedEvent) {
        callback(normalizedEvent);
      }
    });
  }

  protected handleAPIResponse(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) {
      return false;
    }

    const response = message as BaseAPIResponse;
    if (!response.echo || !this.pendingRequests.has(response.echo)) {
      return false;
    }

    const { resolve, reject, timer } = this.pendingRequests.get(response.echo)!;
    clearTimeout(timer);
    this.pendingRequests.delete(response.echo);

    if (response.status === 'ok' && response.retcode === 0) {
      resolve(response.data);
    } else {
      reject(
        new Error(
          `API request failed: ${response.retcode} - ${response.msg || 'Unknown error'}`,
        ),
      );
    }

    return true;
  }

  protected generateEcho(): string {
    return `req_${++this.requestIdCounter}_${Date.now()}`;
  }

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
