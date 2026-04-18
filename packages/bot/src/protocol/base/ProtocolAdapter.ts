// Abstract base class for protocol adapters
// Transport-agnostic — only holds connection reference, config, and abstract declarations.

import { EventEmitter } from 'events';
import type { APIContext, ForwardMessageInput, SendMessageResult, SendTarget } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import type { Connection } from '@/core/connection';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import type { BaseEvent } from './types';

/** Resolve API action and params from a SendTarget. Shared by all adapters. */
export function resolveAction(target: SendTarget): { action: string; params: Record<string, unknown> } {
  if (target.messageScene === 'temp' && target.groupId) {
    return {
      action: 'send_private_msg',
      params: { user_id: target.userId, group_id: target.groupId },
    };
  }
  if (target.messageType === 'private') {
    return { action: 'send_private_msg', params: { user_id: target.userId } };
  }
  return { action: 'send_group_msg', params: { group_id: target.groupId } };
}

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

  /** Low-level API call (used by adapters internally and by APIClient). */
  abstract sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse>;

  abstract onEvent(callback: (event: BaseEvent) => void): void;

  // ── High-level send methods (each adapter implements its own conversion) ──

  /** Send a message. Each adapter handles segment conversion internally. */
  abstract sendMessage(
    message: string | MessageSegment[],
    target: SendTarget,
    timeout?: number,
  ): Promise<SendMessageResult>;

  /**
   * Send a forward (merged) message. Default: not supported.
   * Override in adapters that support it (e.g. Milky).
   */
  async sendForwardMessage(
    _messages: ForwardMessageInput[],
    _target: SendTarget,
    _botUserId: number | string,
    _timeout?: number,
  ): Promise<SendMessageResult> {
    throw new Error(`Forward message is not supported for protocol: ${this.getProtocolName()}`);
  }

  /** Whether this adapter supports forward messages. Override to return true. */
  supportsForwardMessage(): boolean {
    return false;
  }

  /**
   * Fetch a single message from the protocol server by sequence number.
   * Used as a last-resort fallback when cache and DB both miss.
   * Override in adapters that support get_message API.
   */
  async fetchMessage(
    _messageSeq: number,
    _peerId: number | string,
    _scene: string,
  ): Promise<NormalizedMessageEvent | null> {
    return null;
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
