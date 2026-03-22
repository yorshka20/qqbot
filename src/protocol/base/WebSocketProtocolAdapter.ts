// WebSocket-specific protocol adapter
// Extracted from the original ProtocolAdapter — handles echo-based request tracking via WS.

import type { APIContext } from '@/api/types';
import type { ProtocolConfig } from '@/core/config';
import type { Connection, WebSocketConnection } from '@/core/connection';
import { logger } from '@/utils/logger';
import { ProtocolAdapter } from './ProtocolAdapter';
import type { BaseAPIRequest, BaseAPIResponse, BaseEvent } from './types';

export abstract class WebSocketProtocolAdapter extends ProtocolAdapter {
  protected override connection: Connection & { send(data: string): void };
  protected pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestIdCounter = 0;

  constructor(config: ProtocolConfig, connection: WebSocketConnection) {
    super(config, connection);
    this.connection = connection;
  }

  override disconnect(): void {
    super.disconnect();
    // Clear all pending requests
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Connection closed'));
    });
    this.pendingRequests.clear();
  }

  /**
   * Send API request using context-based approach.
   * Context contains all call information (action, params, timeout, etc.)
   */
  async sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse> {
    if (!this.isConnected()) {
      throw new Error(`Protocol ${this.getProtocolName()} is not connected`);
    }

    // Generate echo ID and store it in context for tracking
    const echo = this.generateEcho();
    context.setEcho(echo);

    const request: BaseAPIRequest = {
      action: context.action,
      params: context.params,
      echo,
    };

    return new Promise<TResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`API request timeout: ${context.action} (protocol: ${context.protocol})`));
      }, context.timeout);

      this.pendingRequests.set(echo, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        if (this.config.mockSendMessage) {
          logger.info(`[ProtocolAdapter] Mock sending message: ${JSON.stringify(request)}`);
        } else {
          this.connection.send(JSON.stringify(request));
        }
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
    const pending = response.echo ? this.pendingRequests.get(response.echo) : undefined;
    if (!pending) {
      return false;
    }

    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    this.pendingRequests.delete(response.echo ?? '');

    if (response.status === 'ok' && response.retcode === 0) {
      resolve(response.data);
    } else {
      reject(new Error(`API request failed: ${response.retcode} - ${response.msg || 'Unknown error'}`));
    }

    return true;
  }

  protected generateEcho(): string {
    return `req_${++this.requestIdCounter}_${Date.now()}`;
  }
}
