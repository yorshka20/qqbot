// TTS Provider Health Adapter — wraps TTSProvider for HealthCheckManager

import type { TTSProvider } from '@/services/tts/TTSProvider';
import type { HealthCheckable, HealthCheckOptions, HealthCheckResult } from './types';
import { HealthStatus } from './types';

/**
 * Adapter that wraps a `TTSProvider` so it can be registered with `HealthCheckManager`
 * under the same service name as `provider.name` (used by `TTSManager` fallback).
 */
export class TtsProviderHealthAdapter implements HealthCheckable {
  constructor(private readonly provider: TTSProvider) {}

  getServiceName(): string {
    return this.provider.name;
  }

  async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const timeout = options?.timeout ?? 10_000;
    const startTime = Date.now();

    if (!this.provider.isAvailable()) {
      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: 'TTS provider not available (missing API key / endpoint)',
      };
    }

    try {
      const ok = await Promise.race([
        this.runHealthProbe(),
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
      ]);

      return {
        status: ok ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: ok ? 'TTS health check ok' : 'TTS health check returned false',
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

  private async runHealthProbe(): Promise<boolean> {
    if (typeof this.provider.healthCheck === 'function') {
      return this.provider.healthCheck();
    }
    return true;
  }
}
