// Provider Factory - creates AI providers from configuration

import type { AIProviderConfig } from '@/core/Config';
import { logger } from '@/utils/logger';
import type { AIProvider } from './base/AIProvider';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { DeepSeekProvider } from './providers/DeepSeekProvider';
import { OllamaProvider } from './providers/OllamaProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';

/**
 * Provider Factory
 * Creates AI provider instances from configuration
 */
export class ProviderFactory {
  /**
   * Create a provider instance from configuration
   */
  static createProvider(name: string, config: AIProviderConfig): AIProvider | null {
    try {
      switch (config.type) {
        case 'openai': {
          return new OpenAIProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseURL: config.baseURL,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens,
          });
        }
        case 'ollama': {
          return new OllamaProvider({
            baseUrl: config.baseUrl,
            model: config.model,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens || 2000,
          });
        }
        case 'anthropic': {
          return new AnthropicProvider({
            apiKey: config.apiKey,
            model: config.model,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens,
          });
        }
        case 'deepseek': {
          return new DeepSeekProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseURL: config.baseURL,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens,
          });
        }
        default: {
          logger.warn(`[ProviderFactory] Unknown provider type: ${(config as any).type}`);
          return null;
        }
      }
    } catch (error) {
      logger.error(`[ProviderFactory] Failed to create provider ${name}:`, error);
      return null;
    }
  }

  /**
   * Create multiple providers from configuration
   */
  static createProviders(
    providersConfig: Record<string, AIProviderConfig>,
  ): Array<{ name: string; provider: AIProvider }> {
    const providers: Array<{ name: string; provider: AIProvider }> = [];

    for (const [name, config] of Object.entries(providersConfig)) {
      const provider = this.createProvider(name, config);
      if (provider) {
        providers.push({ name, provider });
      }
    }

    return providers;
  }
}
