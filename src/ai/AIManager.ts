// AI Manager - manages AI providers and handles provider switching

import { logger } from '@/utils/logger';
import type { AIProvider } from './base/AIProvider';
import type { CapabilityType } from './capabilities/types';
import { ProviderRegistry } from './ProviderRegistry';

export class AIManager {
  private providers = new Map<string, AIProvider>();
  private registry = new ProviderRegistry();
  private defaultProviders = new Map<CapabilityType, string>();

  /**
   * Register an AI provider
   * @param provider - Provider to register
   * @param autoSetDefault - If true, automatically set as default for capabilities if no default is set (default: false)
   */
  registerProvider(provider: AIProvider, autoSetDefault: boolean = false): void {
    if (!provider.isAvailable()) {
      logger.warn(`[AIManager] Provider ${provider.name} is not available, skipping registration`);
      return;
    }

    this.providers.set(provider.name, provider);
    this.registry.registerProvider(provider);
    logger.info(`[AIManager] Registered provider: ${provider.name}`);

    // Set as default for each capability if autoSetDefault is true and no default is set
    if (autoSetDefault) {
      const capabilities = provider.getCapabilities();
      for (const capability of capabilities) {
        if (!this.defaultProviders.has(capability)) {
          this.defaultProviders.set(capability, provider.name);
          logger.info(`[AIManager] Set ${provider.name} as default provider for ${capability}`);
        }
      }
    }
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
}
