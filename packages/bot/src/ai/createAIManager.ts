// AIManager assembly: a bare AIManager is only a registry, so the app's instance is built
// here from `ai.providers` and `ai.defaultProviders`. The DI factory for AI_MANAGER calls
// this, which is why anything resolving AI_MANAGER gets a manager that already knows its
// providers.

import type { AIConfig, Config } from '@/core/config';
import { logger } from '@/utils/logger';
import { AIManager, type ProviderDefaultCapability } from './AIManager';
import { ProviderFactory } from './ProviderFactory';

export function createAIManager(config: Config): AIManager {
  const aiManager = new AIManager();
  configureAIManager(aiManager, config);
  return aiManager;
}

/**
 * Configure AI Manager with providers from config
 */
function configureAIManager(aiManager: AIManager, config: Config): void {
  const aiConfig = config.getAIConfig();
  if (!aiConfig) {
    logger.warn('[AIManager] No AI configuration found. AI capabilities will not be available.');
    return;
  }

  const providers = ProviderFactory.createProviders(aiConfig.providers);
  const registeredProviders: string[] = [];

  for (const { name, provider } of providers) {
    try {
      aiManager.registerProvider(provider);
      registeredProviders.push(name);
    } catch (error) {
      logger.warn(`[AIManager] Failed to register provider ${name}:`, error);
    }
  }

  if (registeredProviders.length === 0) {
    return;
  }

  configureDefaultProviders(aiManager, aiConfig);
}

/**
 * Configure default providers by capability
 * Priority: 1. Config specified providers, 2. First available provider
 */
function configureDefaultProviders(aiManager: AIManager, aiConfig: AIConfig): void {
  const validCapabilities: ProviderDefaultCapability[] = ['vision', 'video_analysis', 'text2img', 'img2img', 'i2v'];

  // Log configured defaults to simplify provider setup debugging.
  if (aiConfig.defaultProviders) {
    logger.debug(`[AIManager] defaultProviders from config: ${JSON.stringify(aiConfig.defaultProviders)}`);
  }

  configureDefaultLLM(aiManager, aiConfig);

  // First pass: respect explicit defaults from config.
  if (aiConfig.defaultProviders) {
    for (const capability of validCapabilities) {
      const providerName = aiConfig.defaultProviders[capability];
      if (!providerName) {
        continue;
      }

      try {
        aiManager.setDefaultProvider(capability, providerName);
      } catch (error) {
        logger.warn(`[AIManager] Failed to set default provider ${providerName} for ${capability}:`, error);
      }
    }
  }

  // Second pass: use the first available provider for any unset capability.
  for (const capability of validCapabilities) {
    if (aiManager.getDefaultProvider(capability)) {
      continue;
    }

    const allProviders = aiManager.getAllProviders();
    const firstAvailableProvider = allProviders.find(
      (p) => p.getCapabilities().includes(capability) && p.isAvailable(),
    );

    if (firstAvailableProvider) {
      try {
        aiManager.setDefaultProvider(capability, firstAvailableProvider.name);
        logger.info(
          `[AIManager] Set ${firstAvailableProvider.name} as default provider for ${capability} (first available)`,
        );
      } catch (error) {
        logger.warn(
          `[AIManager] Failed to set default provider ${firstAvailableProvider.name} for ${capability}:`,
          error,
        );
      }
    } else {
      logger.warn(`[AIManager] No available providers for capability ${capability}`);
    }
  }
}

/** The configured default LLM, else the first available LLM provider on its own model. */
function configureDefaultLLM(aiManager: AIManager, aiConfig: AIConfig): void {
  const configured = aiConfig.defaultProviders?.llm;
  if (configured) {
    try {
      aiManager.setDefaultLLM(configured);
      return;
    } catch (error) {
      logger.warn(`[AIManager] Failed to set default LLM ${configured.provider}:`, error);
    }
  }

  const [firstAvailable] = aiManager.getProvidersForCapability('llm');
  if (!firstAvailable) {
    logger.warn('[AIManager] No available providers for capability llm');
    return;
  }
  aiManager.setDefaultLLM({ provider: firstAvailable.name });
  logger.info(`[AIManager] Set ${firstAvailable.name} as default LLM (first available)`);
}
