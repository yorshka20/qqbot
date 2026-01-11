// Routes API calls to appropriate protocol adapter

import type { ProtocolAdapter } from '@/protocol/base/ProtocolAdapter';
import type { APIStrategy } from './types';
import type { ProtocolName } from '@/core/Config';
import { logger } from '@/utils/logger';

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

  getAdapter(protocol?: ProtocolName): ProtocolAdapter | null {
    if (protocol) {
      return this.adapters.get(protocol) || null;
    }

    return this.selectAdapter();
  }

  private selectAdapter(): ProtocolAdapter | null {
    const connectedAdapters = Array.from(this.adapters.entries()).filter(
      ([, adapter]) => adapter.isConnected()
    );

    if (connectedAdapters.length === 0) {
      logger.warn('[APIRouter] No connected adapters available');
      return null;
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

  private selectByPriority(
    adapters: Array<[ProtocolName, ProtocolAdapter]>
  ): ProtocolAdapter {
    if (this.preferredProtocol) {
      const preferred = adapters.find(([name]) => name === this.preferredProtocol);
      if (preferred) {
        return preferred[1];
      }
    }

    // Return first available adapter
    return adapters[0][1];
  }

  private selectRoundRobin(
    adapters: Array<[ProtocolName, ProtocolAdapter]>
  ): ProtocolAdapter {
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
