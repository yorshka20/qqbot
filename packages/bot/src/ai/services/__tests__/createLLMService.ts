import type { AIManager } from '@/ai/AIManager';
import type { ProviderSelector } from '@/ai/ProviderSelector';
import type { Config } from '@/core/config';
import type { LLMTarget } from '@/core/config/types/ai';
import type { HealthCheckManager } from '@/core/health';
import { LLMService, type LLMServiceConfig } from '../LLMService';

const EMPTY_CONFIG: LLMServiceConfig = { toolUseProviders: [], fallback: { fallbackOrder: [] } };

/** Session and health state a test can set; by default no session overrides and every provider healthy. */
export interface LLMServiceTestState {
  sessionLLM?: LLMTarget;
  unhealthy?: string[];
}

/**
 * An LLMService with no session provider selections and every provider healthy, so a
 * test exercises only the AIManager and the LLM config it passes.
 */
export function createLLMService(
  aiManager: AIManager,
  llmConfig: LLMServiceConfig = EMPTY_CONFIG,
  state: LLMServiceTestState = {},
): LLMService {
  const providerSelector = {
    getSessionOverride: async () => state.sessionLLM ?? null,
  } as unknown as ProviderSelector;
  const healthCheckManager = {
    isServiceHealthySync: (name: string) => !state.unhealthy?.includes(name),
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
