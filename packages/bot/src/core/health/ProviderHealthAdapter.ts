// Provider Health Adapter - wraps AIProvider to implement HealthCheckable

import type { AIProvider } from '@/ai/base/AIProvider';
import type { HealthCheckable, HealthCheckOptions, HealthCheckResult } from './types';
import { HealthStatus } from './types';

/**
 * Adapter that wraps an AIProvider to implement HealthCheckable interface.
 * This allows each AI provider to be registered individually with HealthCheckManager.
 */
export class ProviderHealthAdapter implements HealthCheckable {
  constructor(private readonly provider: AIProvider) {}

  /**
   * Get the service name for identification.
   * Uses the provider's name to match LLMService's usage.
   */
  getServiceName(): string {
    return this.provider.name;
  }

  /**
   * Perform health check by calling provider's checkAvailability method.
   */
  async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const timeout = options?.timeout ?? 8000;
    const startTime = Date.now();

    // Check sync availability first
    if (!this.provider.isAvailable()) {
      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: 'Provider not available (config/API key missing)',
      };
    }

    try {
      const isHealthy = await Promise.race([
        this.provider.checkAvailability(),
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
      ]);

      return {
        status: isHealthy ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: isHealthy ? 'Provider available' : 'Provider check returned false',
      };
    } catch (error) {
      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
