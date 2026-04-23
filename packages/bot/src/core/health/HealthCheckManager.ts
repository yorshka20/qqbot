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
  consecutiveFailures: number;
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
  private failureThreshold = 2; // Mark unhealthy after this many consecutive failures

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
    const existing = this.cache.get(serviceName);

    // Track consecutive failures
    let consecutiveFailures = 0;
    if (result.status === HealthStatus.UNHEALTHY) {
      consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    }

    this.cache.set(serviceName, {
      result,
      expiresAt: Date.now() + cacheDuration,
      consecutiveFailures,
    });
  }

  /**
   * Reactively mark a service as healthy (e.g., after a successful API call).
   * Resets consecutive failures and caches a HEALTHY result.
   */
  markServiceHealthy(serviceName: string): void {
    const config = this.configs.get(serviceName);
    const cacheDuration = config?.cacheDuration ?? this.defaultCacheDuration;

    const result: HealthCheckResult = {
      status: HealthStatus.HEALTHY,
      timestamp: Date.now(),
      message: 'Marked healthy reactively',
    };

    this.cache.set(serviceName, {
      result,
      expiresAt: Date.now() + cacheDuration,
      consecutiveFailures: 0,
    });
  }

  /**
   * Reactively mark a service as unhealthy (e.g., after a failed API call).
   * Increments consecutive failures. If threshold reached, caches UNHEALTHY status.
   */
  markServiceUnhealthy(serviceName: string, message?: string): void {
    const config = this.configs.get(serviceName);
    const cacheDuration = config?.cacheDuration ?? this.defaultCacheDuration;
    const existing = this.cache.get(serviceName);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;

    // Only mark as UNHEALTHY if threshold reached
    const status = consecutiveFailures >= this.failureThreshold ? HealthStatus.UNHEALTHY : HealthStatus.HEALTHY;

    const result: HealthCheckResult = {
      status,
      timestamp: Date.now(),
      message: message ?? `Failed ${consecutiveFailures} time(s)`,
    };

    this.cache.set(serviceName, {
      result,
      expiresAt: Date.now() + cacheDuration,
      consecutiveFailures,
    });

    if (status === HealthStatus.UNHEALTHY) {
      logger.warn(
        `[HealthCheckManager] Service ${serviceName} marked UNHEALTHY after ${consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Synchronous check if a service is healthy based on cached status.
   * Returns true if no cache entry exists (unknown = assume healthy for fallback).
   */
  isServiceHealthySync(serviceName: string): boolean {
    const cached = this.cache.get(serviceName);
    if (!cached) {
      return true; // No status = assume healthy
    }
    return cached.result.status === HealthStatus.HEALTHY;
  }

  /**
   * Get consecutive failure count for a service.
   */
  getConsecutiveFailures(serviceName: string): number {
    return this.cache.get(serviceName)?.consecutiveFailures ?? 0;
  }

  /**
   * Reset a service's cached status and consecutive failure counter.
   * The next health probe will run against the provider as if it were freshly registered.
   * Useful for admin recovery flows when a provider was marked UNHEALTHY due to transient issues.
   */
  resetService(serviceName: string): boolean {
    if (!this.services.has(serviceName)) {
      return false;
    }
    this.cache.delete(serviceName);
    logger.info(`[HealthCheckManager] Reset cached health state for ${serviceName}`);
    return true;
  }

  /**
   * Force re-check a service bypassing cache, and reset the consecutive failure counter
   * before the probe runs. Unlike plain checkHealth({ force: true }), this guarantees the
   * service is eligible to flip back to HEALTHY on a single successful probe, even if the
   * counter was elevated by previous failures. If the probe fails, the counter becomes 1.
   */
  async forceRefresh(serviceName: string, options?: HealthCheckOptions): Promise<HealthCheckResult> {
    if (!this.services.has(serviceName)) {
      return {
        status: HealthStatus.UNKNOWN,
        timestamp: Date.now(),
        message: `Service ${serviceName} not registered`,
      };
    }
    this.cache.delete(serviceName);
    logger.info(`[HealthCheckManager] Force refreshing health for ${serviceName}`);
    return this.checkHealth(serviceName, { ...options, force: true });
  }

  /**
   * Get the current cached health result for a service without triggering a new probe.
   * Returns null when no entry exists (i.e., never checked or already reset).
   * Differs from getCachedResult() in that it does NOT evict expired entries.
   */
  peekCachedResult(serviceName: string): HealthCheckResult | null {
    return this.cache.get(serviceName)?.result ?? null;
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
