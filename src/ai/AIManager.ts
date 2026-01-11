// AI Manager - manages AI providers and handles provider switching

import type { AIProvider } from './base/AIProvider';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from './types';
import { logger } from '@/utils/logger';

export class AIManager {
  private providers = new Map<string, AIProvider>();
  private currentProviderName: string | null = null;

  /**
   * Register an AI provider
   */
  registerProvider(provider: AIProvider): void {
    if (!provider.isAvailable()) {
      logger.warn(`[AIManager] Provider ${provider.name} is not available, skipping registration`);
      return;
    }

    this.providers.set(provider.name, provider);
    logger.info(`[AIManager] Registered provider: ${provider.name}`);

    // Set as current if no current provider
    if (!this.currentProviderName) {
      this.currentProviderName = provider.name;
      logger.info(`[AIManager] Set ${provider.name} as current provider`);
    }
  }

  /**
   * Unregister a provider
   */
  unregisterProvider(name: string): boolean {
    if (this.providers.delete(name)) {
      // If current provider was removed, switch to first available
      if (this.currentProviderName === name) {
        const firstProvider = Array.from(this.providers.keys())[0];
        this.currentProviderName = firstProvider || null;
        if (this.currentProviderName) {
          logger.info(`[AIManager] Switched to provider: ${this.currentProviderName}`);
        }
      }
      logger.info(`[AIManager] Unregistered provider: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Set current provider
   */
  setCurrentProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider ${name} not found`);
    }

    const provider = this.providers.get(name)!;
    if (!provider.isAvailable()) {
      throw new Error(`Provider ${name} is not available`);
    }

    this.currentProviderName = name;
    logger.info(`[AIManager] Switched to provider: ${name}`);
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): AIProvider | null {
    if (!this.currentProviderName) {
      return null;
    }
    return this.providers.get(this.currentProviderName) || null;
  }

  /**
   * Get provider by name
   */
  getProvider(name: string): AIProvider | null {
    return this.providers.get(name) || null;
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
   * Generate text using current provider
   */
  async generate(
    prompt: string,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    const provider = providerName
      ? this.getProvider(providerName)
      : this.getCurrentProvider();

    if (!provider) {
      throw new Error('No AI provider available');
    }

    if (!provider.isAvailable()) {
      throw new Error(`Provider ${provider.name} is not available`);
    }

    return await provider.generate(prompt, options);
  }

  /**
   * Generate text with streaming using current provider
   */
  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    const provider = providerName
      ? this.getProvider(providerName)
      : this.getCurrentProvider();

    if (!provider) {
      throw new Error('No AI provider available');
    }

    if (!provider.isAvailable()) {
      throw new Error(`Provider ${provider.name} is not available`);
    }

    return await provider.generateStream(prompt, handler, options);
  }
}
