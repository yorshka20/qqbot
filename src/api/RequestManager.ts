// Request/response tracking with echo IDs

import type { APIRequest, APIResponse } from './types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
  protocol: string;
  timestamp: number;
}

export class RequestManager {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;

  generateEcho(): string {
    return `req_${++this.requestIdCounter}_${Date.now()}`;
  }

  registerRequest(
    echo: string,
    action: string,
    protocol: string,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timeout = 10000,
  ): void {
    const timer = setTimeout(() => {
      const request = this.pendingRequests.get(echo);
      if (request) {
        this.pendingRequests.delete(echo);
        reject(new Error(`API request timeout: ${action} (protocol: ${protocol})`));
      }
    }, timeout);

    this.pendingRequests.set(echo, {
      resolve,
      reject,
      timer,
      action,
      protocol,
      timestamp: Date.now(),
    });
  }

  handleResponse(response: APIResponse): boolean {
    if (!response.echo || !this.pendingRequests.has(response.echo)) {
      return false;
    }

    const request = this.pendingRequests.get(response.echo)!;
    clearTimeout(request.timer);
    this.pendingRequests.delete(response.echo);

    if (response.status === 'ok' && response.retcode === 0) {
      request.resolve(response.data);
    } else {
      request.reject(
        new Error(
          `API request failed: ${response.retcode} - ${response.msg || 'Unknown error'} (action: ${request.action}, protocol: ${request.protocol})`,
        ),
      );
    }

    return true;
  }

  clearAll(): void {
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Request manager cleared'));
    });
    this.pendingRequests.clear();
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }
}
