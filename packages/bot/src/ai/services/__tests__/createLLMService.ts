import type { AIManager } from '@/ai/AIManager';
import type { ProviderSelector } from '@/ai/ProviderSelector';
import type { Config } from '@/core/config';
import type { HealthCheckManager } from '@/core/health';
import { LLMService, type LLMServiceConfig } from '../LLMService';

const EMPTY_CONFIG: LLMServiceConfig = { toolUseProviders: [], fallback: { fallbackOrder: [] } };

/**
 * An LLMService with no session provider selections and every provider healthy, so a
 * test exercises only the AIManager and the LLM config it passes.
 */
export function createLLMService(aiManager: AIManager, llmConfig: LLMServiceConfig = EMPTY_CONFIG): LLMService {
  const providerSelector = { getProviderForSession: async () => null } as unknown as ProviderSelector;
  const healthCheckManager = {
    isServiceHealthySync: () => true,
    markServiceHealthy: () => {},
    markServiceUnhealthy: () => {},
  } as unknown as HealthCheckManager;
  const config = {
    getAIConfig: () => ({
      toolUseProviders: llmConfig.toolUseProviders,
      llmFallback: llmConfig.fallback,
      rateLimit: llmConfig.rateLimit,
    }),
  } as unknown as Config;
  return new LLMService(aiManager, providerSelector, healthCheckManager, config);
}
