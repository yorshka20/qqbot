// Unified multi-protocol API client

import type { ConversationContext } from '@/context/types';
import type { ProtocolName } from '@/core/Config';
import type { ProtocolAdapter } from '@/protocol/base/ProtocolAdapter';
import { APIError } from '@/utils/errors';
import { APIRouter } from './APIRouter';
import { RequestManager } from './RequestManager';
import type { APIStrategy } from './types';
import { APIContext } from './types';

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

  /**
   * Call API action with context-based approach.
   * Context contains all call information and can be extended without changing method signature.
   * This follows the pattern used in backend frameworks (Express, Koa, Fastify, etc.)
   *
   * The context is passed through the entire call chain:
   * APIClient -> APIRouter -> ProtocolAdapter -> Connection
   * This allows any layer to access or modify context information without
   * changing method signatures.
   *
   * @param action - API action name
   * @param params - API parameters
   * @param protocol - Protocol name
   * @param timeout - Request timeout (default: 10000ms)
   * @param conversationContext - Optional conversation context for better integration
   */
  async call<TResponse = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    protocol: ProtocolName,
    timeout = 10000,
    conversationContext?: ConversationContext,
  ): Promise<TResponse> {
    // Create context for this API call - all information is encapsulated here
    const context = new APIContext(action, params, protocol, timeout);

    // Store conversation context in metadata if provided
    if (conversationContext) {
      context.metadata.set('conversationContext', conversationContext);
    }

    // Get adapter using context - router can access all needed info from context
    const adapter = this.router.getAdapter(context);

    try {
      // Execute API call - pass context directly, adapter extracts what it needs
      const response = await adapter.sendAPI<TResponse>(context);
      return response;
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error('Unknown error');
      throw new APIError(`API call failed: ${err.message}`, context.action);
    }
  }

  getAvailableProtocols(): ProtocolName[] {
    return this.router.getAvailableProtocols();
  }
}
