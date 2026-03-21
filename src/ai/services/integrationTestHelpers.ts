/**
 * Shared helpers for AI service integration tests (real LLM API + real tool execution).
 * Tests that use these helpers require config.jsonc (or CONFIG_PATH) with a configured provider.
 *
 * Usage:
 *   - getIntegrationProvider('doubao') to check if provider is available
 *   - createAIManagerWithProvider('doubao') to build AIManager with that provider as default LLM
 *   - Use describe.skipIf(!getIntegrationProvider('doubao')) to skip the suite when not configured
 */

import { AIManager } from '@/ai/AIManager';
import type { AIProvider } from '@/ai/base/AIProvider';
import { ProviderFactory } from '@/ai/ProviderFactory';
import type { ToolDefinition } from '@/ai/types';
import { Config } from '@/core/config';

/** All provider names supported by integration tests. */
export type IntegrationProviderName = 'doubao' | 'deepseek' | 'gemini' | 'openai' | 'anthropic';

/** All providers that support tool/function calling. */
export const ALL_TOOL_USE_PROVIDERS: IntegrationProviderName[] = [
  'doubao',
  'deepseek',
  'gemini',
  'openai',
  'anthropic',
];

let cachedConfig: Config | null | undefined;

export function loadConfigOnce(): Config | null {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }
  try {
    const configPath = process.env.CONFIG_PATH;
    cachedConfig = new Config(configPath);
    return cachedConfig;
  } catch {
    cachedConfig = null;
    return null;
  }
}

const cachedProviders: Record<string, AIProvider | null> = {};

export function getIntegrationProvider(name: IntegrationProviderName): AIProvider | null {
  if (cachedProviders[name] !== undefined) {
    return cachedProviders[name];
  }
  const config = loadConfigOnce();
  if (!config) {
    cachedProviders[name] = null;
    return null;
  }
  const aiConfig = config.getAIConfig();
  const providerConfig = aiConfig?.providers?.[name];
  if (!providerConfig) {
    cachedProviders[name] = null;
    return null;
  }
  const provider = ProviderFactory.createProvider(name, providerConfig);
  if (!provider || !provider.isAvailable()) {
    cachedProviders[name] = null;
    return null;
  }
  cachedProviders[name] = provider;
  return provider;
}

export function createAIManagerWithProvider(providerName: IntegrationProviderName): AIManager {
  const manager = new AIManager();
  const provider = getIntegrationProvider(providerName);
  if (provider) {
    manager.registerProvider(provider);
    manager.setDefaultProvider('llm', providerName);
  }
  return manager;
}

/** Timeout for a single real API call (e.g. generate, generateMessages). */
export const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

/** Timeout for multi-round tool-use tests. */
export const INTEGRATION_TOOL_USE_TIMEOUT_MS = 60_000;

/** Sample tools for tool-use integration tests (get_weather, search). */
export const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a given city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. Beijing, Shanghai' },
        unit: {
          type: 'string',
          description: 'Temperature unit: celsius or fahrenheit',
          enum: ['celsius', 'fahrenheit'],
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'search',
    description: 'Search the web for a query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];
