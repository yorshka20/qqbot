// Health check types and interfaces

/**
 * Health check status
 */
export enum HealthStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

/**
 * Health check result with detailed information
 */
export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: number;
  message?: string;
  details?: Record<string, unknown>;
  responseTime?: number; // Response time in milliseconds
}

/**
 * Health check options
 */
export interface HealthCheckOptions {
  timeout?: number; // Timeout in milliseconds
  force?: boolean; // Force fresh check, bypass cache
  retries?: number; // Number of retries on failure
}

/**
 * Interface for services that support health checks
 */
export interface HealthCheckable {
  /**
   * Perform health check for this service
   */
  checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult>;

  /**
   * Get the service name for identification
   */
  getServiceName(): string;
}

/**
 * Health check configuration for a service
 */
export interface ServiceHealthConfig {
  serviceName: string;
  checkInterval?: number; // Auto-check interval in milliseconds (0 = no auto-check)
  cacheDuration?: number; // Cache duration in milliseconds
  timeout?: number; // Default timeout for health checks
  retries?: number; // Default number of retries
}
