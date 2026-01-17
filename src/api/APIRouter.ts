// Routes API calls to appropriate protocol adapter

import type { ProtocolName } from '@/core/config';
import type { ProtocolAdapter } from '@/protocol/base/ProtocolAdapter';
import { APIError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import type { APIStrategy } from './types';
import { APIContext } from './types';

export class APIRouter {
  private adapters = new Map<ProtocolName, ProtocolAdapter>();
  private strategy: APIStrategy;
  private preferredProtocol?: ProtocolName;
  private roundRobinIndex = 0;

  constructor(strategy: APIStrategy, preferredProtocol?: ProtocolName) {
    this.strategy = strategy;
    this.preferredProtocol = preferredProtocol;
  }

  registerAdapter(protocol: ProtocolName, adapter: ProtocolAdapter): void {
    this.adapters.set(protocol, adapter);
    logger.debug(`[APIRouter] Registered adapter for protocol: ${protocol}`);
  }

  unregisterAdapter(protocol: ProtocolName): void {
    this.adapters.delete(protocol);
    logger.debug(`[APIRouter] Unregistered adapter for protocol: ${protocol}`);
  }

  /**
   * Get adapter for the context's protocol or select one based on strategy.
   * Throws APIError if no adapter is available.
   * Uses context to access action and protocol information - no need to pass them separately.
   * Stores selected protocol in context for tracking and debugging.
   */
  getAdapter(context: APIContext): ProtocolAdapter {
    // If user specified a protocol, use it
    if (context.protocol) {
      const adapter = this.adapters.get(context.protocol);
      if (!adapter || !adapter.isConnected()) {
        const availableProtocols = this.getAvailableProtocols();
        throw new APIError(
          `Protocol "${context.protocol}" is not available. Available: ${availableProtocols.join(', ') || 'none'}`,
          context.action,
        );
      }
      return adapter;
    }

    // User didn't specify protocol, select one based on strategy
    const adapter = this.selectAdapter(context);

    return adapter;
  }

  /**
   * Select adapter based on strategy.
   * Throws APIError if no connected adapter is available.
   */
  private selectAdapter(context: APIContext): ProtocolAdapter {
    const connectedAdapters = Array.from(this.adapters.entries()).filter(([, adapter]) => adapter.isConnected());

    if (connectedAdapters.length === 0) {
      const registeredProtocols = Array.from(this.adapters.keys());
      logger.warn('[APIRouter] No connected adapters available');
      throw new APIError(
        registeredProtocols.length === 0
          ? 'No protocols registered. Please ensure protocols are configured and enabled.'
          : `No connected protocols available. Registered protocols: ${registeredProtocols.join(', ')}. Please wait for connections to establish.`,
        context.action,
      );
    }

    switch (this.strategy) {
      case 'priority':
        return this.selectByPriority(connectedAdapters);
      case 'round-robin':
        return this.selectRoundRobin(connectedAdapters);
      case 'capability-based':
        // For now, fallback to priority
        return this.selectByPriority(connectedAdapters);
      default:
        return connectedAdapters[0][1];
    }
  }

  private selectByPriority(adapters: Array<[ProtocolName, ProtocolAdapter]>): ProtocolAdapter {
    if (this.preferredProtocol) {
      const preferred = adapters.find(([name]) => name === this.preferredProtocol);
      if (preferred) {
        return preferred[1];
      }
    }

    // Return first available adapter
    return adapters[0][1];
  }

  private selectRoundRobin(adapters: Array<[ProtocolName, ProtocolAdapter]>): ProtocolAdapter {
    if (adapters.length === 0) {
      throw new Error('No adapters available');
    }

    const index = this.roundRobinIndex % adapters.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % adapters.length;
    return adapters[index][1];
  }

  getAvailableProtocols(): ProtocolName[] {
    return Array.from(this.adapters.keys()).filter((protocol) => {
      const adapter = this.adapters.get(protocol);
      return adapter?.isConnected() ?? false;
    });
  }
}
