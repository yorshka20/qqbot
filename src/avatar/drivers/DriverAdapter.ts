import { EventEmitter } from 'node:events';

/**
 * Abstract Driver Adapter.
 *
 * Emits:
 *  - 'connected'
 *  - 'disconnected' (error?: Error)
 *  - 'error' (error: Error)
 */
export abstract class DriverAdapter extends EventEmitter {
  abstract readonly name: string;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendFrame(params: Record<string, number>): Promise<void>;
  abstract isConnected(): boolean;
}
