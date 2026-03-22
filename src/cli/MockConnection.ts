// Mock Connection for simulation mode
// Always reports as connected, but doesn't actually connect anywhere

import type { ProtocolConfig } from '@/core/config';
import { Connection, type ConnectionState } from '@/core/connection';

/**
 * Mock Connection for simulation mode
 * Always reports as connected, but doesn't actually connect anywhere
 */
export class MockConnection extends Connection {
  private mockState: ConnectionState = 'connected';

  constructor(config: ProtocolConfig) {
    super(config);
    // Immediately set as connected
    this.mockState = 'connected';
  }

  override getState(): ConnectionState {
    return this.mockState;
  }

  override async connect(): Promise<void> {
    this.mockState = 'connected';
    // Emit open event to simulate connection
    setTimeout(() => {
      this.emit('open');
    }, 0);
  }

  override disconnect(): void {
    this.mockState = 'disconnected';
    this.emit('close');
  }
}
