import { singleton } from 'tsyringe';
import type { HealthCheckManager } from '@/core/health';
import { TtsProviderHealthAdapter } from '@/core/health/TtsProviderHealthAdapter';
import { HealthStatus } from '@/core/health/types';
import { logger } from '@/utils/logger';
import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from './TTSProvider';

/** A synthesis request routed by the manager rather than aimed at one provider. */
export interface TTSSynthesizeRequest extends TTSSynthesizeOptions {
  /** Preferred provider name; the manager default is used when omitted. */
  provider?: string;
  /**
   * Restrict selection *and* fallback to backends that interpret inline cues.
   * Callers whose text carries delivery cues must set this: falling back to a
   * cue-less backend would deliver the words with the direction silently
   * dropped, which is a different message, not a degraded one.
   */
  requireInlineCues?: boolean;
}

export interface TTSSynthesisOutcome {
  result: SynthesisResult;
  /** Provider that actually produced the audio. */
  provider: TTSProvider;
  /** True when the audio came from something other than the requested/default provider. */
  usedFallback: boolean;
  requestedProvider?: string;
}

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

  /** Configured default provider name, regardless of its current health. */
  getDefaultName(): string | null {
    return this.defaultName;
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

  /**
   * Pick a provider for a request. `filter` narrows the eligible set to
   * backends that can honor the request (e.g. cue support) — it applies to the
   * preferred provider as well as to the fallback search, so an ineligible
   * preference is never used just because it happens to be healthy.
   */
  async resolveProvider(
    preferredName?: string,
    opts?: { filter?: (provider: TTSProvider) => boolean },
  ): Promise<{
    provider: TTSProvider | null;
    usedFallback: boolean;
    requestedProvider?: string;
  }> {
    const filter = opts?.filter;
    if (preferredName) {
      const preferred = this.registry.get(preferredName);
      if (!preferred) {
        return { provider: null, usedFallback: false, requestedProvider: preferredName };
      }
      if ((!filter || filter(preferred)) && (await this.checkProviderHealth(preferredName))) {
        return { provider: preferred, usedFallback: false, requestedProvider: preferredName };
      }
      const fallback = await this.findFirstHealthyProvider([preferredName], filter);
      return { provider: fallback, usedFallback: fallback !== null, requestedProvider: preferredName };
    }

    if (this.defaultName) {
      const defaultProvider = this.registry.get(this.defaultName);
      if (
        defaultProvider &&
        (!filter || filter(defaultProvider)) &&
        (await this.checkProviderHealth(this.defaultName))
      ) {
        return { provider: defaultProvider, usedFallback: false };
      }
      const fallback = await this.findFirstHealthyProvider([this.defaultName], filter);
      return { provider: fallback, usedFallback: fallback !== null };
    }

    const fallback = await this.findFirstHealthyProvider([], filter);
    return { provider: fallback, usedFallback: false };
  }

  async getFallbackProvider(
    excludeNames: string[],
    filter?: (provider: TTSProvider) => boolean,
  ): Promise<TTSProvider | null> {
    return this.findFirstHealthyProvider(excludeNames, filter);
  }

  /** Whether a registered provider is configured and currently believed healthy. */
  isProviderUsable(name: string): boolean {
    const provider = this.registry.get(name);
    return provider ? this.isProviderUsableSync(provider) : false;
  }

  /**
   * Synthesize through the healthiest suitable provider, retrying once on a
   * different provider if the chosen one fails at runtime. Every caller needs
   * this same resolve → synthesize → mark-unhealthy → retry sequence, so it
   * lives here instead of being re-implemented per call site.
   *
   * Throws when no provider can produce audio; the last error is propagated.
   */
  async synthesize(text: string, req: TTSSynthesizeRequest = {}): Promise<TTSSynthesisOutcome> {
    const { provider: preferredName, requireInlineCues, ...opts } = req;
    const filter = requireInlineCues ? (p: TTSProvider) => p.capabilities.inlineCues !== 'none' : undefined;
    const resolved = await this.resolveProvider(preferredName, { filter });
    const primary = resolved.provider;
    if (!primary) {
      throw new Error(
        preferredName && !this.registry.has(preferredName)
          ? `TTS provider "${preferredName}" is not registered`
          : requireInlineCues
            ? 'No healthy TTS provider with inline-cue support is available'
            : 'No healthy TTS provider is available',
      );
    }

    try {
      const result = await primary.synthesize(text, opts);
      this.markProviderHealthy(primary.name);
      return {
        result,
        provider: primary,
        usedFallback: resolved.usedFallback,
        requestedProvider: resolved.requestedProvider,
      };
    } catch (primaryError) {
      this.markProviderUnhealthy(
        primary.name,
        primaryError instanceof Error ? primaryError.message : String(primaryError),
      );
      const fallback = await this.getFallbackProvider([primary.name], filter);
      if (!fallback) {
        throw primaryError;
      }
      logger.warn(
        `[TTSManager] Provider "${primary.name}" synthesis failed, retrying with fallback "${fallback.name}"`,
        primaryError,
      );
      const result = await fallback.synthesize(text, { ...opts, voice: this.adaptVoice(opts.voice, fallback) });
      this.markProviderHealthy(fallback.name);
      return { result, provider: fallback, usedFallback: true, requestedProvider: resolved.requestedProvider };
    }
  }

  /** Drop a voice name the target provider does not know, so it uses its own default. */
  private adaptVoice(voice: string | undefined, provider: TTSProvider): string | undefined {
    if (!voice || !provider.listVoices) {
      return voice;
    }
    const voices = provider.listVoices();
    if (voices.length === 0 || voices.includes(voice)) {
      return voice;
    }
    logger.warn(
      `[TTSManager] Voice "${voice}" not supported by "${provider.name}", falling back to that provider's default voice`,
    );
    return undefined;
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

  private async findFirstHealthyProvider(
    excludeNames: string[] = [],
    filter?: (provider: TTSProvider) => boolean,
  ): Promise<TTSProvider | null> {
    const excluded = new Set(excludeNames);
    const candidates = [...this.registry.values()].filter((p) => !excluded.has(p.name) && (!filter || filter(p)));
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
