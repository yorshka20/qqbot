// Base protocol types

import { ProtocolName } from '@/core/config';

export interface BaseEvent {
  id: string;
  type: string;
  timestamp: number;
  protocol: ProtocolName;
}

export interface BaseAPIRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

export interface BaseAPIResponse<T = unknown> {
  status: string;
  retcode: number;
  data?: T;
  echo?: string;
  msg?: string;
}

export interface ProtocolAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  sendAPI<TRequest, TResponse>(
    action: string,
    params?: Record<string, unknown>
  ): Promise<TResponse>;
  onEvent(callback: (event: BaseEvent) => void): void;
  getProtocolName(): string;
  isConnected(): boolean;
}
