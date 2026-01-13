// Provider Factory - creates AI providers from configuration

import type { AIProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import type { AIProvider } from './base/AIProvider';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { DeepSeekProvider } from './providers/DeepSeekProvider';
import { LocalText2ImageProvider } from './providers/LocalText2ImageProvider';
import { NovelAIProvider } from './providers/NovelAIProvider';
import { OllamaProvider } from './providers/OllamaProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';

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
            enableContext: config.enableContext,
            contextMessageCount: config.contextMessageCount,
          });
        }
        case 'ollama': {
          return new OllamaProvider({
            baseUrl: config.baseUrl,
            model: config.model,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens || 2000,
            enableContext: config.enableContext,
            contextMessageCount: config.contextMessageCount,
          });
        }
        case 'anthropic': {
          return new AnthropicProvider({
            apiKey: config.apiKey,
            model: config.model,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens,
            enableContext: config.enableContext,
            contextMessageCount: config.contextMessageCount,
          });
        }
        case 'deepseek': {
          return new DeepSeekProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseURL: config.baseURL,
            defaultTemperature: config.temperature,
            defaultMaxTokens: config.maxTokens,
            enableContext: config.enableContext,
            contextMessageCount: config.contextMessageCount,
          });
        }
        case 'local-text2img': {
          const localConfig = config as Extract<AIProviderConfig, { type: 'local-text2img' }>;
          return new LocalText2ImageProvider({
            baseUrl: localConfig.baseUrl,
            endpoint: localConfig.endpoint,
            timeout: localConfig.timeout,
            censorEnabled: localConfig.censorEnabled,
            // Default values
            defaultSteps: localConfig.defaultSteps,
            defaultWidth: localConfig.defaultWidth,
            defaultHeight: localConfig.defaultHeight,
            defaultGuidanceScale: localConfig.defaultGuidanceScale,
            defaultNumImages: localConfig.defaultNumImages,
          });
        }
        case 'openrouter': {
          const openRouterConfig = config as Extract<AIProviderConfig, { type: 'openrouter' }>;
          return new OpenRouterProvider({
            type: 'openrouter',
            apiKey: openRouterConfig.apiKey,
            model: openRouterConfig.model,
            baseURL: openRouterConfig.baseURL,
            temperature: openRouterConfig.temperature,
            maxTokens: openRouterConfig.maxTokens,
            enableContext: openRouterConfig.enableContext,
            contextMessageCount: openRouterConfig.contextMessageCount,
            httpReferer: openRouterConfig.httpReferer,
            siteName: openRouterConfig.siteName,
          });
        }
        case 'novelai': {
          const novelAIConfig = config as Extract<AIProviderConfig, { type: 'novelai' }>;
          return new NovelAIProvider({
            type: 'novelai',
            accessToken: novelAIConfig.accessToken,
            baseURL: novelAIConfig.baseURL,
            model: novelAIConfig.model, // Pass model configuration
            defaultSteps: novelAIConfig.defaultSteps,
            defaultWidth: novelAIConfig.defaultWidth,
            defaultHeight: novelAIConfig.defaultHeight,
            defaultGuidanceScale: novelAIConfig.defaultGuidanceScale,
            defaultStrength: novelAIConfig.defaultStrength,
            defaultNoise: novelAIConfig.defaultNoise,
            resourceSavePath: novelAIConfig.resourceSavePath,
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
