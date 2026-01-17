// API layer types

import type { ProtocolName } from '@/core/config';

export interface APIRequest {
  action: string;
  params: Record<string, unknown>;
  echo: string;
  protocol?: string;
}

export interface APIResponse<T = unknown> {
  status: string;
  retcode: number;
  data?: T;
  echo?: string;
  msg?: string;
}

export type APIStrategy = 'priority' | 'round-robin' | 'capability-based';

/**
 * API Context - contains all information about an API call
 * Similar to request context in backend frameworks (Express, Koa, Fastify, etc.)
 * This allows passing all call information through the call chain without
 * adding parameters to every method signature.
 */
export class APIContext {
  readonly action: string;
  readonly params: Record<string, unknown>;
  readonly protocol: ProtocolName;
  readonly timeout: number;
  readonly timestamp: number;
  readonly metadata: Map<string, unknown>;

  // Request tracking
  private _echo?: string;

  constructor(action: string, params: Record<string, unknown> = {}, protocol: ProtocolName, timeout = 10000) {
    this.action = action;
    this.params = params;
    this.protocol = protocol;
    this.timeout = timeout;
    this.timestamp = Date.now();
    this.metadata = new Map();
  }

  /**
   * Get or generate echo ID for request tracking
   */
  get echo(): string {
    if (!this._echo) {
      this._echo = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return this._echo;
  }

  /**
   * Set echo ID (used by adapters)
   */
  setEcho(echo: string): void {
    this._echo = echo;
  }

  /**
   * Get metadata value
   */
  getMetadata(key: string): unknown {
    return this.metadata.get(key);
  }

  /**
   * Set metadata value
   */
  setMetadata(key: string, value: unknown): void {
    this.metadata.set(key, value);
  }

  /**
   * Create a new context with updated values
   */
  clone(updates?: Partial<Pick<APIContext, 'protocol' | 'timeout'>>): APIContext {
    const context = new APIContext(
      this.action,
      this.params,
      updates?.protocol ?? this.protocol,
      updates?.timeout ?? this.timeout,
    );
    // Copy metadata
    this.metadata.forEach((value, key) => {
      context.metadata.set(key, value);
    });
    // Copy echo if set
    if (this._echo) {
      context.setEcho(this._echo);
    }
    return context;
  }
}
