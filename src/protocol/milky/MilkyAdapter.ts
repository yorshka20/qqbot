// Milky protocol adapter implementation

import type { APIContext } from '@/api/types';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import { Connection } from '@/core/Connection';
import { logger } from '@/utils/logger';
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
  constructor(config: ProtocolConfig, connection: Connection) {
    super(config, connection);
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
    const apiUrl = this.config.connection.apiUrl;
    const accessToken = this.config.connection.accessToken;

    if (!apiUrl) {
      throw new Error('API URL is not configured for Milky protocol');
    }

    // Convert unified API action names (OneBot11-style) to Milky protocol endpoints
    const milkyAction = MilkyAPIConverter.convertActionToMilky(context.action);

    // Convert unified API parameters (OneBot11-style) to Milky protocol format
    const milkyParams = MilkyAPIConverter.convertParamsToMilky(milkyAction, context.params);

    logger.debug(
      `[MilkyAdapter] Calling API: ${milkyAction} (echo: ${context.echo}) with params:`,
      JSON.stringify(milkyParams),
    );

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), context.timeout);

      // Make HTTP POST request
      const response = await fetch(`${apiUrl}/${milkyAction}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        },
        body: JSON.stringify(milkyParams),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle response: parse JSON and validate Milky API format
      return MilkyAPIResponseHandler.handleResponse<TResponse>(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`API request timeout: ${context.action} (protocol: milky, echo: ${context.echo})`);
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }
}
