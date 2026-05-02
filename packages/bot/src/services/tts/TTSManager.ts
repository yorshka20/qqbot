import { singleton } from 'tsyringe';
import type { HealthCheckManager } from '@/core/health';
import { TtsProviderHealthAdapter } from '@/core/health/TtsProviderHealthAdapter';
import { HealthStatus } from '@/core/health/types';
import type { TTSProvider } from './TTSProvider';

/**
 * Registry + routing for bot-level TTS backends.
 *
 * Health:
 * - When `attachHealthManager` is called (from bootstrap), each registered provider is
 *   also registered with `HealthCheckManager` under `provider.name`, using
 *   `TtsProviderHealthAdapter` (calls `TTSProvider.healthCheck()` when present).
 * - Selection/fallback (`resolveProvider`) uses `HealthCheckManager.checkHealth()` so
 *   cached probe results match global health status and `/tts` runtime markings.
 */
@singleton()
export class TTSManager {
  private readonly registry = new Map<string, TTSProvider>();
  private defaultName: string | null = null;

  private healthManager: HealthCheckManager | null = null;
  private readonly healthRegisteredNames = new Set<string>();

  register(provider: TTSProvider): void {
    this.registry.set(provider.name, provider);
    if (this.defaultName === null) {
      this.defaultName = provider.name;
    }
    this.syncProviderToHealthManager(provider);
  }

  unregister(name: string): boolean {
    const existed = this.registry.delete(name);
    if (existed) {
      this.unregisterProviderFromHealthManager(name);
    }
    if (existed && this.defaultName === name) {
      const next = this.registry.keys().next();
      this.defaultName = next.done ? null : next.value;
    }
    return existed;
  }

  get(name: string): TTSProvider | null {
    return this.registry.get(name) ?? null;
  }

  getDefault(): TTSProvider | null {
    if (this.defaultName !== null) {
      const provider = this.registry.get(this.defaultName);
      if (provider && this.isProviderUsableSync(provider)) {
        return provider;
      }
    }
    return this.getFirstUsableProviderSync(this.defaultName ? [this.defaultName] : []);
  }

  setDefault(name: string): void {
    if (!this.registry.has(name)) {
      throw new Error(`TTSManager: provider "${name}" is not registered`);
    }
    this.defaultName = name;
  }

  list(): TTSProvider[] {
    return [...this.registry.values()].filter((p) => this.isProviderUsableSync(p));
  }

  listAll(): TTSProvider[] {
    return [...this.registry.values()];
  }

  /**
   * Wire this manager into the global `HealthCheckManager` and register all already-known providers.
   * Safe to call once during bootstrap; replaces any previous attachment.
   */
  attachHealthManager(manager: HealthCheckManager): void {
    this.detachHealthManager();
    this.healthManager = manager;
    for (const provider of this.registry.values()) {
      this.registerProviderWithHealthManager(provider);
    }
    // Auto-warmup so the first /tts request never pays cold-probe latency.
    // Coupled with attach so callers can't forget; lives entirely inside the
    // TTS module instead of leaking into bootstrap.
    this.warmupHealthCache();
  }

  /**
   * Probe timeout for TTS provider health checks. A provider that can't ack a
   * health ping in 2s is effectively unusable for interactive use, and a long
   * timeout here directly translates to pipeline delay on cold cache /
   * fallback paths. Keep this tight; attach-time warmup covers the cold case.
   */
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 2_000;

  async checkProviderHealth(name: string, force = false): Promise<boolean> {
    const provider = this.registry.get(name);
    if (!provider) {
      return false;
    }

    if (!provider.isAvailable()) {
      return false;
    }

    if (this.healthManager) {
      const result = await this.healthManager.checkHealth(name, {
        force,
        timeout: TTSManager.HEALTH_PROBE_TIMEOUT_MS,
      });
      return result.status === HealthStatus.HEALTHY;
    }

    if (typeof provider.healthCheck === 'function') {
      try {
        return await provider.healthCheck();
      } catch {
        return false;
      }
    }

    return true;
  }

  async resolveProvider(preferredName?: string): Promise<{
    provider: TTSProvider | null;
    usedFallback: boolean;
    requestedProvider?: string;
  }> {
    if (preferredName) {
      const preferred = this.registry.get(preferredName);
      if (!preferred) {
        return { provider: null, usedFallback: false, requestedProvider: preferredName };
      }
      if (await this.checkProviderHealth(preferredName)) {
        return { provider: preferred, usedFallback: false, requestedProvider: preferredName };
      }
      const fallback = await this.findFirstHealthyProvider([preferredName]);
      return { provider: fallback, usedFallback: fallback !== null, requestedProvider: preferredName };
    }

    if (this.defaultName) {
      const defaultProvider = this.registry.get(this.defaultName);
      if (defaultProvider && (await this.checkProviderHealth(this.defaultName))) {
        return { provider: defaultProvider, usedFallback: false };
      }
      const fallback = await this.findFirstHealthyProvider([this.defaultName]);
      return { provider: fallback, usedFallback: fallback !== null };
    }

    const fallback = await this.findFirstHealthyProvider();
    return { provider: fallback, usedFallback: false };
  }

  async getFallbackProvider(excludeNames: string[]): Promise<TTSProvider | null> {
    return this.findFirstHealthyProvider(excludeNames);
  }

  markProviderHealthy(name: string): void {
    this.healthManager?.markServiceHealthy(name);
  }

  markProviderUnhealthy(name: string, message?: string): void {
    this.healthManager?.markServiceUnhealthy(name, message);
  }

  private detachHealthManager(): void {
    if (!this.healthManager) {
      return;
    }
    for (const serviceName of this.healthRegisteredNames) {
      this.healthManager.unregisterService(serviceName);
    }
    this.healthRegisteredNames.clear();
    this.healthManager = null;
  }

  private syncProviderToHealthManager(provider: TTSProvider): void {
    if (!this.healthManager) {
      return;
    }
    this.registerProviderWithHealthManager(provider);
  }

  private registerProviderWithHealthManager(provider: TTSProvider): void {
    if (!this.healthManager) {
      return;
    }
    if (this.healthRegisteredNames.has(provider.name)) {
      this.healthManager.unregisterService(provider.name);
      this.healthRegisteredNames.delete(provider.name);
    }
    this.healthManager.registerService(new TtsProviderHealthAdapter(provider), {
      cacheDuration: 60_000,
      checkInterval: 0,
    });
    this.healthRegisteredNames.add(provider.name);
  }

  private unregisterProviderFromHealthManager(name: string): void {
    if (!this.healthManager) {
      return;
    }
    if (!this.healthRegisteredNames.has(name)) {
      return;
    }
    this.healthManager.unregisterService(name);
    this.healthRegisteredNames.delete(name);
  }

  private isProviderUsableSync(provider: TTSProvider): boolean {
    if (!provider.isAvailable()) {
      return false;
    }
    if (this.healthManager) {
      return this.healthManager.isServiceHealthySync(provider.name);
    }
    return true;
  }

  private getFirstUsableProviderSync(excludeNames: string[] = []): TTSProvider | null {
    const excluded = new Set(excludeNames);
    for (const p of this.registry.values()) {
      if (excluded.has(p.name)) {
        continue;
      }
      if (this.isProviderUsableSync(p)) {
        return p;
      }
    }
    return null;
  }

  private async findFirstHealthyProvider(excludeNames: string[] = []): Promise<TTSProvider | null> {
    const excluded = new Set(excludeNames);
    const candidates = [...this.registry.values()].filter((p) => !excluded.has(p.name));
    if (candidates.length === 0) {
      return null;
    }
    // Probe candidates in parallel — sequential await of multiple unhealthy
    // providers would compound timeouts (e.g. 2s × 3 providers = 6s) before
    // returning a healthy one. With Promise.all the worst case is the slowest
    // single probe, not the sum.
    const results = await Promise.all(
      candidates.map(async (p) => ({ provider: p, healthy: await this.checkProviderHealth(p.name) })),
    );
    return results.find((r) => r.healthy)?.provider ?? null;
  }

  /**
   * Fire-and-forget warmup: probe every registered provider in parallel and
   * populate the health cache. Bootstrap calls this so the first user request
   * does not pay cold-start probe latency. Errors are swallowed — the probe
   * itself records UNHEALTHY in the cache, which is the desired outcome.
   */
  warmupHealthCache(): void {
    if (!this.healthManager) {
      return;
    }
    for (const provider of this.registry.values()) {
      if (!provider.isAvailable()) continue;
      void this.checkProviderHealth(provider.name, true).catch(() => {
        // checkProviderHealth itself caches failures; nothing else to do here.
      });
    }
  }
}
