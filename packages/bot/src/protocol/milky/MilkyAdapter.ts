// Milky protocol adapter implementation

import { HttpClient } from '@/api/http/HttpClient';
import type { ForwardMessageInput, SendMessageResult, SendTarget } from '@/api/types';
import { APIContext } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import type { WebSocketConnection } from '@/core/connection';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { resolveAction } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import { WebSocketProtocolAdapter } from '../base/WebSocketProtocolAdapter';
import { MilkyAPIConverter } from './MilkyAPIConverter';
import { MilkyAPIResponseHandler } from './MilkyAPIResponseHandler';
import { MilkyEventNormalizer } from './MilkyEventNormalizer';
import { segmentsToMilkyOutgoing } from './MilkySegmentConverter';

/**
 * Milky protocol adapter
 * Converts Milky protocol events and API calls to unified format
 */
export class MilkyAdapter extends WebSocketProtocolAdapter {
  private httpClient: HttpClient;

  constructor(config: ProtocolConfig, connection: WebSocketConnection) {
    super(config, connection);

    const apiUrl = this.config.connection.apiUrl;
    if (!apiUrl) {
      throw new Error('API URL is not configured for Milky protocol');
    }

    // Configure HttpClient for Milky protocol API calls
    const defaultHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.connection.accessToken) {
      defaultHeaders.Authorization = `Bearer ${this.config.connection.accessToken}`;
    }

    this.httpClient = new HttpClient({
      baseURL: apiUrl,
      defaultHeaders,
      defaultTimeout: 10000, // 10 seconds default timeout (can be overridden per request)
    });
  }

  getProtocolName(): ProtocolName {
    return 'milky';
  }

  override supportsForwardMessage(): boolean {
    return true;
  }

  /** Convert segments to Milky outgoing format and send. */
  async sendMessage(
    message: string | MessageSegment[],
    target: SendTarget,
    timeout = 10000,
  ): Promise<SendMessageResult> {
    const { action, params } = resolveAction(target);
    const protocolMessage = Array.isArray(message) ? segmentsToMilkyOutgoing(message) : message;
    const ctx = new APIContext(action, { ...params, message: protocolMessage }, 'milky', timeout);
    return this.sendAPI<SendMessageResult>(ctx);
  }

  /** Build forward segment structure and send. */
  override async sendForwardMessage(
    messages: ForwardMessageInput[],
    target: SendTarget,
    botUserId: number | string,
    timeout = 10000,
  ): Promise<SendMessageResult> {
    if (!messages || messages.length === 0) {
      throw new Error('sendForwardMessage requires at least one message');
    }
    const nodes = messages.map((m) => ({
      user_id: m.senderId ?? botUserId,
      sender_name: m.senderName ?? 'Bot',
      segments: segmentsToMilkyOutgoing(m.segments),
    }));
    const forwardSegment = { type: 'forward' as const, data: { messages: nodes } };
    const { action, params } = resolveAction(target);
    const ctx = new APIContext(action, { ...params, message: [forwardSegment] }, 'milky', timeout);
    return this.sendAPI<SendMessageResult>(ctx);
  }

  normalizeEvent(rawEvent: unknown): BaseEvent | null {
    return MilkyEventNormalizer.normalizeEvent(rawEvent);
  }

  /**
   * Fetch a message from the Milky protocol server via get_message API.
   * Wraps the response as a synthetic message_receive event and normalizes it
   * through MilkyEventNormalizer so all protocol-specific logic stays here.
   */
  override async fetchMessage(
    messageSeq: number,
    peerId: number | string,
    scene: string,
  ): Promise<NormalizedMessageEvent | null> {
    try {
      const ctx = new APIContext(
        'get_message',
        { message_scene: scene, peer_id: peerId, message_seq: messageSeq },
        'milky',
        15000,
      );
      const response = await this.sendAPI<{ message?: Record<string, unknown> }>(ctx);
      const msg = response?.message;
      if (!msg) return null;

      // Wrap as a synthetic message_receive event so the existing normalizer handles all details
      const syntheticEvent = {
        event_type: 'message_receive' as const,
        data: msg,
      };
      const normalized = MilkyEventNormalizer.normalizeEvent(syntheticEvent);
      if (!normalized || normalized.type !== 'message') return null;

      logger.info(`[MilkyAdapter] Fetched message from server | messageSeq=${messageSeq} | peerId=${peerId}`);
      return normalized as NormalizedMessageEvent;
    } catch (error) {
      logger.warn(
        `[MilkyAdapter] fetchMessage failed | messageSeq=${messageSeq} | error=${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return null;
    }
  }

  /**
   * Override sendAPI to use HTTP POST instead of WebSocket for Milky protocol
   * Converts API parameters to Milky protocol format
   * Uses context-based approach to access all call information
   */
  async sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse> {
    // Convert action names to Milky protocol endpoints
    const milkyAction = MilkyAPIConverter.convertActionToMilky(context.action);

    // Convert API parameters to Milky protocol format
    const milkyParams = MilkyAPIConverter.convertParamsToMilky(milkyAction, context.params);

    if (this.config.mockSendMessage) {
      logger.info(`[MilkyAdapter] Mock sending message: ${JSON.stringify(milkyParams)}`);
      return { message_seq: Date.now() } as TResponse;
    }

    try {
      // use MilkyAPIResponseHandler to handle Milky-specific response format
      const rawData = await this.httpClient.post<unknown>(`/${milkyAction}`, milkyParams, {
        timeout: context.timeout,
      });

      // Handle Milky API response format using MilkyAPIResponseHandler
      return MilkyAPIResponseHandler.handleParsedResponse<TResponse>(rawData);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          throw new Error(`API request timeout: ${context.action} (protocol: milky, echo: ${context.echo})`);
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }
}
