// Base HTTP health check implementation

import { logger } from '@/utils/logger';
import type { HealthCheckable, HealthCheckOptions, HealthCheckResult } from './types';
import { HealthStatus } from './types';

/**
 * Base health check implementation for HTTP services
 * Provides common functionality for HTTP-based health checks
 */
export abstract class BaseHttpHealthCheck implements HealthCheckable {
  protected serviceName: string;
  protected healthCheckUrl: string;
  protected defaultTimeout: number;

  constructor(serviceName: string, healthCheckUrl: string, defaultTimeout: number = 5000) {
    this.serviceName = serviceName;
    this.healthCheckUrl = healthCheckUrl;
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Get service name
   */
  getServiceName(): string {
    return this.serviceName;
  }

  /**
   * Perform health check
   */
  async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const retries = options?.retries ?? 0;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const startTime = Date.now();
        const response = await this.performCheck(timeout);
        const responseTime = Date.now() - startTime;

        if (response.ok) {
          return {
            status: HealthStatus.HEALTHY,
            timestamp: Date.now(),
            responseTime,
            message: 'Service is healthy',
          };
        } else {
          return {
            status: HealthStatus.UNHEALTHY,
            timestamp: Date.now(),
            responseTime,
            message: `Service returned error: ${response.status} ${response.statusText}`,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if should retry
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 500; // Exponential backoff: 500ms, 1s, 2s...
          logger.debug(
            `[${this.serviceName}] Health check failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`,
          );
          await this.delay(delay);
          continue;
        }
      }
    }

    // All attempts failed
    return {
      status: HealthStatus.UNHEALTHY,
      timestamp: Date.now(),
      message: lastError?.message || 'Health check failed',
    };
  }

  /**
   * Perform the actual health check (to be implemented by subclasses)
   */
  protected async performCheck(timeout: number): Promise<{ ok: boolean; status?: number; statusText?: string }> {
    try {
      const response = await fetch(this.healthCheckUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Delay helper
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
