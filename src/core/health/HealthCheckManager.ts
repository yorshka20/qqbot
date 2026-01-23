// Health check manager - centralized management of service health checks

import { logger } from '@/utils/logger';
import type { HealthCheckable, HealthCheckOptions, HealthCheckResult, ServiceHealthConfig } from './types';
import { HealthStatus } from './types';

/**
 * Cached health check entry
 */
interface CachedHealthCheck {
  result: HealthCheckResult;
  expiresAt: number;
}

/**
 * Health check manager
 * Provides centralized health check management with caching and auto-refresh
 */
export class HealthCheckManager {
  private services = new Map<string, HealthCheckable>();
  private configs = new Map<string, ServiceHealthConfig>();
  private cache = new Map<string, CachedHealthCheck>();
  private checkIntervals = new Map<string, NodeJS.Timeout>();

  private defaultCacheDuration = 60000; // 60 seconds
  private defaultTimeout = 5000; // 5 seconds
  private defaultRetries = 0; // No retries by default

  /**
   * Register a service for health check management
   */
  registerService(service: HealthCheckable, config?: Partial<ServiceHealthConfig>): void {
    const serviceName = service.getServiceName();

    if (this.services.has(serviceName)) {
      logger.warn(`[HealthCheckManager] Service ${serviceName} is already registered, replacing...`);
      this.unregisterService(serviceName);
    }

    this.services.set(serviceName, service);

    // Set up configuration
    const serviceConfig: ServiceHealthConfig = {
      serviceName,
      cacheDuration: config?.cacheDuration ?? this.defaultCacheDuration,
      timeout: config?.timeout ?? this.defaultTimeout,
      retries: config?.retries ?? this.defaultRetries,
      checkInterval: config?.checkInterval ?? 0,
    };
    this.configs.set(serviceName, serviceConfig);

    logger.info(`[HealthCheckManager] Registered service: ${serviceName}`);

    // Set up auto-check interval if configured
    if (serviceConfig.checkInterval && serviceConfig.checkInterval > 0) {
      this.startAutoCheck(serviceName, serviceConfig.checkInterval);
    }
  }

  /**
   * Unregister a service
   */
  unregisterService(serviceName: string): void {
    // Stop auto-check if running
    this.stopAutoCheck(serviceName);

    // Remove from all maps
    this.services.delete(serviceName);
    this.configs.delete(serviceName);
    this.cache.delete(serviceName);

    logger.info(`[HealthCheckManager] Unregistered service: ${serviceName}`);
  }

  /**
   * Check health of a specific service
   */
  async checkHealth(serviceName: string, options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const service = this.services.get(serviceName);
    if (!service) {
      return {
        status: HealthStatus.UNKNOWN,
        timestamp: Date.now(),
        message: `Service ${serviceName} not registered`,
      };
    }

    // Check cache unless force refresh
    if (!options?.force) {
      const cached = this.getCachedResult(serviceName);
      if (cached) {
        return cached;
      }
    }

    // Perform health check with configured defaults
    const config = this.configs.get(serviceName);
    const checkOptions: HealthCheckOptions = {
      timeout: options?.timeout ?? config?.timeout ?? this.defaultTimeout,
      retries: options?.retries ?? config?.retries ?? this.defaultRetries,
    };

    const startTime = Date.now();
    try {
      const result = await service.checkHealth(checkOptions);
      result.responseTime = Date.now() - startTime;

      // Cache the result
      this.cacheResult(serviceName, result);

      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        message: error instanceof Error ? error.message : String(error),
        responseTime: Date.now() - startTime,
      };

      // Cache the failure result too
      this.cacheResult(serviceName, result);

      return result;
    }
  }

  /**
   * Check health of all registered services
   */
  async checkAllServices(options?: HealthCheckOptions): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();
    const promises: Promise<void>[] = [];

    for (const serviceName of this.services.keys()) {
      promises.push(
        this.checkHealth(serviceName, options).then((result) => {
          results.set(serviceName, result);
        }),
      );
    }

    await Promise.all(promises);
    return results;
  }

  /**
   * Get health status of a service (from cache or fresh check)
   */
  async isServiceHealthy(serviceName: string, options?: HealthCheckOptions): Promise<boolean> {
    const result = await this.checkHealth(serviceName, options);
    return result.status === HealthStatus.HEALTHY;
  }

  /**
   * Get cached health check result if available and not expired
   */
  getCachedResult(serviceName: string): HealthCheckResult | null {
    const cached = this.cache.get(serviceName);
    if (!cached) {
      return null;
    }

    const now = Date.now();
    if (now >= cached.expiresAt) {
      // Cache expired
      this.cache.delete(serviceName);
      return null;
    }

    return cached.result;
  }

  /**
   * Cache health check result
   */
  private cacheResult(serviceName: string, result: HealthCheckResult): void {
    const config = this.configs.get(serviceName);
    const cacheDuration = config?.cacheDuration ?? this.defaultCacheDuration;

    this.cache.set(serviceName, {
      result,
      expiresAt: Date.now() + cacheDuration,
    });
  }

  /**
   * Start automatic health check for a service
   */
  private startAutoCheck(serviceName: string, interval: number): void {
    this.stopAutoCheck(serviceName); // Clear existing interval if any

    const intervalId = setInterval(async () => {
      try {
        await this.checkHealth(serviceName, { force: true });
      } catch (error) {
        logger.error(`[HealthCheckManager] Auto health check failed for ${serviceName}:`, error);
      }
    }, interval);

    this.checkIntervals.set(serviceName, intervalId);
    logger.debug(`[HealthCheckManager] Started auto health check for ${serviceName} (interval: ${interval}ms)`);
  }

  /**
   * Stop automatic health check for a service
   */
  private stopAutoCheck(serviceName: string): void {
    const intervalId = this.checkIntervals.get(serviceName);
    if (intervalId) {
      clearInterval(intervalId);
      this.checkIntervals.delete(serviceName);
      logger.debug(`[HealthCheckManager] Stopped auto health check for ${serviceName}`);
    }
  }

  /**
   * Clear all cached results
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('[HealthCheckManager] Cache cleared');
  }

  /**
   * Get all registered service names
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get health summary of all services
   */
  async getHealthSummary(): Promise<{
    total: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
    services: Map<string, HealthCheckResult>;
  }> {
    const services = await this.checkAllServices();

    let healthy = 0;
    let unhealthy = 0;
    let unknown = 0;

    for (const result of services.values()) {
      switch (result.status) {
        case HealthStatus.HEALTHY:
          healthy++;
          break;
        case HealthStatus.UNHEALTHY:
          unhealthy++;
          break;
        case HealthStatus.UNKNOWN:
          unknown++;
          break;
      }
    }

    return {
      total: services.size,
      healthy,
      unhealthy,
      unknown,
      services,
    };
  }

  /**
   * Shutdown manager and clean up resources
   */
  shutdown(): void {
    // Stop all auto-check intervals
    for (const serviceName of this.checkIntervals.keys()) {
      this.stopAutoCheck(serviceName);
    }

    // Clear all data
    this.services.clear();
    this.configs.clear();
    this.cache.clear();

    logger.info('[HealthCheckManager] Health check manager shut down');
  }
}
