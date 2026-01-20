// Mock Protocol Adapter for simulation mode
// Returns mock responses for all API calls without actually sending them

import type { APIContext } from '@/api/types';
import { Connection } from '@/core/Connection';
import type { ProtocolConfig, ProtocolName } from '@/core/config';
import { ProtocolAdapter } from '@/protocol/base/ProtocolAdapter';
import type { BaseEvent } from '@/protocol/base/types';

export interface MockProtocolAdapterLogger {
  printMockReply(action: string, params: Record<string, unknown>): void;
  printInfo(message: string): void;
}

/**
 * Mock Protocol Adapter for simulation mode
 * Returns mock responses for all API calls without actually sending them
 */
export class MockProtocolAdapter extends ProtocolAdapter {
  private logger: MockProtocolAdapterLogger;

  constructor(config: ProtocolConfig, connection: Connection, logger: MockProtocolAdapterLogger) {
    super(config, connection);
    this.logger = logger;
  }

  override getProtocolName(): ProtocolName {
    return 'milky';
  }

  override normalizeEvent(_rawEvent: unknown): BaseEvent | null {
    // Mock adapter doesn't receive real events
    return null;
  }

  override async sendAPI<TResponse = unknown>(context: APIContext): Promise<TResponse> {
    const action = context.action;
    const params = context.params;

    // Handle message sending actions
    if (
      action === 'send_private_msg' ||
      action === 'send_group_msg' ||
      action === 'send_private_message' ||
      action === 'send_group_message'
    ) {
      this.logger.printMockReply(action, params);
      // Return mock response with message_seq (Milky protocol format)
      return { message_seq: Date.now() } as TResponse;
    }

    // Handle message recall actions
    if (
      action === 'recall_msg' ||
      action === 'recall_message' ||
      action === 'recall_private_message' ||
      action === 'recall_group_message'
    ) {
      this.logger.printInfo(`[Mock Mode] Would recall message: ${JSON.stringify(params)}`);
      return { success: true } as TResponse;
    }

    // For other API calls, return mock responses based on action type
    // This allows plugins and commands to work without throwing errors
    if (action.startsWith('get_') || action.includes('_list') || action.includes('_info')) {
      // Info/getter APIs return empty arrays or objects
      this.logger.printInfo(`[Mock Mode] API call "${action}" - returning mock data`);
      return (Array.isArray(params) ? [] : {}) as TResponse;
    }

    // For other actions, log and return success response
    this.logger.printInfo(`[Mock Mode] API call "${action}" - returning mock success response`);
    return { success: true } as TResponse;
  }
}
