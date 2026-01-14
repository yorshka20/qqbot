// Milky protocol adapter implementation

import { HttpClient } from '@/api/http/HttpClient';
import type { APIContext } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import { Connection } from '@/core/Connection';
import { ProtocolAdapter } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import { MilkyAPIConverter } from './MilkyAPIConverter';
import { MilkyAPIResponseHandler } from './MilkyAPIResponseHandler';
import { MilkyEventNormalizer } from './MilkyEventNormalizer';

/**
 * Milky protocol adapter
 * Converts Milky protocol events and API calls to unified format
 */
export class MilkyAdapter extends ProtocolAdapter {
  private httpClient: HttpClient;

  constructor(config: ProtocolConfig, connection: Connection) {
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

  normalizeEvent(rawEvent: unknown): BaseEvent | null {
    return MilkyEventNormalizer.normalizeEvent(rawEvent);
  }

  /**
   * Override sendAPI to use HTTP POST instead of WebSocket for Milky protocol
   * Also converts unified API parameters (OneBot11-style) to Milky protocol format
   * Uses context-based approach to access all call information
   */
  async sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse> {
    // Convert unified API action names (OneBot11-style) to Milky protocol endpoints
    const milkyAction = MilkyAPIConverter.convertActionToMilky(context.action);

    // Convert unified API parameters (OneBot11-style) to Milky protocol format
    const milkyParams = MilkyAPIConverter.convertParamsToMilky(milkyAction, context.params);

    try {
      // Use HttpClient to make the request
      // Note: We need to handle the response in Milky API format, so we'll parse it manually
      const data = await this.httpClient.post<unknown>(`/${milkyAction}`, milkyParams, {
        timeout: context.timeout,
      });

      // Handle Milky API response format: { code: number, message?: string, data?: T }
      if (MilkyAPIResponseHandler.isMilkyAPIResponse(data)) {
        if (data.code === 0) {
          // Success - return the data field, or the whole response if no data field
          return (data.data ?? data) as TResponse;
        } else {
          // API error - code is not 0
          const errorMessage = (data as { message?: string }).message || 'Unknown error';
          throw new Error(`Milky API error [${data.code}]: ${errorMessage}`);
        }
      }

      return data as TResponse;
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
