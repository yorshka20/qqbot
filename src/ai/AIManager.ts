// AI Manager - manages AI providers and handles provider switching

import type { HealthCheckable, HealthCheckOptions, HealthCheckResult } from '@/core/health';
import { HealthStatus } from '@/core/health';
import { logger } from '@/utils/logger';
import type { AIProvider } from './base/AIProvider';
import type { CapabilityType } from './capabilities/types';
import { ProviderRegistry } from './ProviderRegistry';

export class AIManager implements HealthCheckable {
  private providers = new Map<string, AIProvider>();
  private registry = new ProviderRegistry();
  private defaultProviders = new Map<CapabilityType, string>();

  /**
   * Register an AI provider
   * @param provider - Provider to register
   */
  registerProvider(provider: AIProvider): void {
    if (!provider.isAvailable()) {
      logger.warn(`[AIManager] Provider ${provider.name} is not available, skipping registration`);
      return;
    }

    this.providers.set(provider.name, provider);
    this.registry.registerProvider(provider);
    logger.info(`[AIManager] Registered provider: ${provider.name}`);
  }

  /**
   * Unregister a provider
   */
  unregisterProvider(name: string): boolean {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }

    // Remove from registry
    this.registry.unregisterProvider(name);

    // Remove from providers map
    this.providers.delete(name);

    // Update default providers if needed
    for (const [capability, defaultName] of this.defaultProviders.entries()) {
      if (defaultName === name) {
        // Find a new default provider for this capability
        const availableProviders = this.registry.getProvidersForCapability(capability);
        if (availableProviders.length > 0) {
          this.defaultProviders.set(capability, availableProviders[0].name);
          logger.info(`[AIManager] Switched default ${capability} provider to: ${availableProviders[0].name}`);
        } else {
          this.defaultProviders.delete(capability);
          logger.info(`[AIManager] No available providers for ${capability}, removed default`);
        }
      }
    }

    logger.info(`[AIManager] Unregistered provider: ${name}`);
    return true;
  }

  /**
   * Set default provider for a capability
   */
  setDefaultProvider(capability: CapabilityType, providerName: string): void {
    const provider = this.registry.getProviderForCapability(capability, providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} does not support capability ${capability} or is not available`);
    }

    this.defaultProviders.set(capability, providerName);
    logger.info(`[AIManager] Set ${providerName} as default provider for ${capability}`);
  }

  /**
   * Get default provider for a capability
   */
  getDefaultProvider(capability: CapabilityType): AIProvider | null {
    const defaultName = this.defaultProviders.get(capability);
    if (!defaultName) {
      return null;
    }

    return this.registry.getProviderForCapability(capability, defaultName);
  }

  /**
   * Get provider by name
   */
  getProvider(name: string): AIProvider | null {
    return this.providers.get(name) || null;
  }

  /**
   * Get provider for a specific capability
   * If providerName is provided, returns that specific provider if it supports the capability
   * Otherwise, returns the default provider for that capability
   */
  getProviderForCapability(capability: CapabilityType, providerName?: string): AIProvider | null {
    if (providerName) {
      return this.registry.getProviderForCapability(capability, providerName);
    }

    return this.getDefaultProvider(capability);
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get available providers (configured and ready)
   */
  getAvailableProviders(): AIProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.isAvailable());
  }

  /**
   * Get current provider (for backward compatibility)
   * Returns the default LLM provider
   */
  getCurrentProvider(capability: CapabilityType = 'llm'): AIProvider | null {
    return this.getDefaultProvider(capability);
  }

  /**
   * Set current provider (for backward compatibility)
   * Sets the default LLM provider
   */
  setCurrentProvider(capability: CapabilityType, name: string): void {
    this.setDefaultProvider(capability, name);
  }

  /**
   * Get service name for health check identification
   */
  getServiceName(): string {
    return 'AIManager';
  }

  /**
   * Perform health check on all available AI providers
   * Returns HEALTHY if at least one provider is available
   * Returns UNHEALTHY if no providers are available
   */
  async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    const timeout = options?.timeout ?? 10000; // 10 second default timeout
    const startTime = Date.now();

    try {
      const availableProviders = this.getAvailableProviders();

      // Check health of all available providers in parallel
      const healthCheckPromises = availableProviders.map(async (provider) => {
        try {
          const checkPromise = provider.checkAvailability();
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Provider health check timeout')), timeout / availableProviders.length);
          });

          const isAvailable = await Promise.race([checkPromise, timeoutPromise]);
          return { provider: provider.name, healthy: isAvailable };
        } catch (error) {
          logger.debug(
            `[AIManager] Health check failed for provider ${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { provider: provider.name, healthy: false };
        }
      });

      const results = await Promise.all(healthCheckPromises);
      const healthyProviders = results.filter((r) => r.healthy);
      const responseTime = Date.now() - startTime;

      const providerStatus = Object.fromEntries(results.map((r) => [r.provider, r.healthy]));

      if (healthyProviders.length === 0) {
        return {
          status: HealthStatus.UNHEALTHY,
          timestamp: Date.now(),
          responseTime,
          message: 'All AI providers failed health check',
          details: {
            totalProviders: availableProviders.length,
            healthyProviders: 0,
            providers: providerStatus,
          },
        };
      }

      return {
        status: HealthStatus.HEALTHY,
        timestamp: Date.now(),
        responseTime,
        message: `${healthyProviders.length}/${availableProviders.length} AI providers are healthy`,
        details: {
          totalProviders: availableProviders.length,
          healthyProviders: healthyProviders.length,
          providers: providerStatus,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[AIManager] Health check failed: ${errorMessage}`);

      return {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        responseTime: Date.now() - startTime,
        message: errorMessage,
      };
    }
  }
}
