// Unified multi-protocol API client

import { APIRouter } from './APIRouter';
import { RequestManager } from './RequestManager';
import type { ProtocolAdapter } from '@/protocol/base/ProtocolAdapter';
import type { APIStrategy, APIRequest } from './types';
import type { ProtocolName } from '@/core/Config';
import { logger } from '@/utils/logger';
import { APIError } from '@/utils/errors';

export class APIClient {
  private router: APIRouter;
  private requestManager: RequestManager;

  constructor(strategy: APIStrategy, preferredProtocol?: ProtocolName) {
    this.router = new APIRouter(strategy, preferredProtocol);
    this.requestManager = new RequestManager();
  }

  registerAdapter(protocol: ProtocolName, adapter: ProtocolAdapter): void {
    this.router.registerAdapter(protocol, adapter);
    
    // Set up adapter to handle API responses
    adapter.onEvent(() => {
      // Events are handled separately, this is just for API responses
    });
  }

  unregisterAdapter(protocol: ProtocolName): void {
    this.router.unregisterAdapter(protocol);
  }

  async call<TResponse = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    protocol?: ProtocolName,
    timeout = 10000
  ): Promise<TResponse> {
    const adapter = this.router.getAdapter(protocol);
    if (!adapter) {
      throw new APIError(
        `No available adapter for protocol ${protocol || 'default'}`,
        action
      );
    }

    try {
      const response = await adapter.sendAPI<TResponse>(action, params, timeout);
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[APIClient] API call failed: ${action}`, err);
      throw new APIError(`API call failed: ${err.message}`, action);
    }
  }

  getAvailableProtocols(): ProtocolName[] {
    return this.router.getAvailableProtocols();
  }
}
