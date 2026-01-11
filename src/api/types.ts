// API layer types

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
