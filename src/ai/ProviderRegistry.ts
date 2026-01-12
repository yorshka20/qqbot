// Provider Registry - organizes providers by capability

import { logger } from '@/utils/logger';
import type { AIProvider } from './base/AIProvider';
import type { CapabilityType } from './capabilities/types';

/**
 * Provider Registry
 * Organizes providers by their capabilities
 */
export class ProviderRegistry {
  // Map of capability type to providers that support it
  private capabilityProviders = new Map<CapabilityType, Map<string, AIProvider>>();

  /**
   * Register a provider and organize it by capabilities
   */
  registerProvider(provider: AIProvider): void {
    const capabilities = provider.getCapabilities();

    for (const capability of capabilities) {
      if (!this.capabilityProviders.has(capability)) {
        this.capabilityProviders.set(capability, new Map());
      }

      const providers = this.capabilityProviders.get(capability)!;
      providers.set(provider.name, provider);

      logger.debug(`[ProviderRegistry] Registered provider ${provider.name} for capability: ${capability}`);
    }
  }

  /**
   * Unregister a provider
   */
  unregisterProvider(providerName: string): void {
    for (const [capability, providers] of this.capabilityProviders.entries()) {
      if (providers.delete(providerName)) {
        logger.debug(`[ProviderRegistry] Unregistered provider ${providerName} from capability: ${capability}`);
      }
    }
  }

  /**
   * Get all providers that support a specific capability
   */
  getProvidersForCapability(capability: CapabilityType): AIProvider[] {
    const providers = this.capabilityProviders.get(capability);
    if (!providers) {
      return [];
    }

    // Return only available providers
    return Array.from(providers.values()).filter((p) => p.isAvailable());
  }

  /**
   * Get a specific provider by name for a capability
   */
  getProviderForCapability(capability: CapabilityType, providerName: string): AIProvider | null {
    const providers = this.capabilityProviders.get(capability);
    if (!providers) {
      return null;
    }

    const provider = providers.get(providerName);
    if (!provider || !provider.isAvailable()) {
      return null;
    }

    return provider;
  }

  /**
   * Get all registered providers (across all capabilities)
   */
  getAllProviders(): AIProvider[] {
    const providerSet = new Set<AIProvider>();

    for (const providers of this.capabilityProviders.values()) {
      for (const provider of providers.values()) {
        providerSet.add(provider);
      }
    }

    return Array.from(providerSet);
  }

  /**
   * Check if a capability has any available providers
   */
  hasCapability(capability: CapabilityType): boolean {
    const providers = this.getProvidersForCapability(capability);
    return providers.length > 0;
  }
}
