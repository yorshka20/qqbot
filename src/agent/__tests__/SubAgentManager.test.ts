import 'reflect-metadata';

import { describe, expect, it, test } from 'bun:test';
import type { SubAgentExecutor } from '@/agent/SubAgentExecutor';
import { SubAgentExecutor as SubAgentExecutorImpl } from '@/agent/SubAgentExecutor';
import type { IToolRunner } from '@/agent/ToolRunner';
import type { SubAgentSession } from '@/agent/types';
import { AIManager } from '@/ai/AIManager';
import type { AIProvider } from '@/ai/base/AIProvider';
import { ProviderFactory } from '@/ai/ProviderFactory';
import { LLMService } from '@/ai/services/LLMService';
import type { FunctionCall, ToolDefinition } from '@/ai/types';
import { Config } from '@/core/config';
import { SubAgentManager } from '../SubAgentManager';
import { SubAgentType } from '../types';

// ---------------------------------------------------------------------------
// Unit tests (no real LLM; mock executor)
// ---------------------------------------------------------------------------

describe('SubAgentManager', () => {
  it('spawn returns sessionId and listByParent finds the session', async () => {
    const manager = new SubAgentManager();
    const sessionId = await manager.spawn(undefined, SubAgentType.RESEARCH, {
      description: 'research task',
      input: { query: 'test' },
    });

    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    expect(sessionId.startsWith('agent:')).toBe(true);

    const byParent = manager.listByParent(undefined);
    expect(byParent.length).toBe(1);
    expect(byParent[0].id).toBe(sessionId);
    expect(byParent[0].type).toBe(SubAgentType.RESEARCH);
    expect(byParent[0].status).toBe('pending');
  });

  it('execute calls executor and returns result', async () => {
    const manager = new SubAgentManager();
    const sessionId = await manager.spawn(undefined, SubAgentType.ANALYSIS, {
      description: 'analyze',
      input: {},
    });

    const mockResult = { summary: 'done' };
    const executor = {
      execute: async (session: SubAgentSession) => {
        manager.updateSessionStatus(session.id, 'completed', mockResult);
        return mockResult;
      },
    } as unknown as SubAgentExecutor;

    manager.setExecutor(executor);

    const result = await manager.execute(sessionId);
    expect(result).toEqual(mockResult);

    const session = manager.getStatus(sessionId);
    expect(session?.status).toBe('completed');
    expect(session?.task.output).toEqual(mockResult);
  });

  it('wait returns task.output after session is completed', async () => {
    const manager = new SubAgentManager();
    const sessionId = await manager.spawn(undefined, SubAgentType.GENERIC, {
      description: 'task',
      input: {},
    });

    const mockOutput = 'subagent output';
    const executor = {
      execute: async (session: SubAgentSession) => {
        manager.updateSessionStatus(session.id, 'completed', mockOutput);
        return mockOutput;
      },
    } as unknown as SubAgentExecutor;

    manager.setExecutor(executor);
    await manager.execute(sessionId);

    const output = await manager.wait(sessionId);
    expect(output).toBe(mockOutput);
  });

  it('wait throws if session not found', async () => {
    const manager = new SubAgentManager();
    await expect(manager.wait('non-existent-id')).rejects.toThrow('Sub-agent session not found');
  });

  it('execute throws if executor not set', async () => {
    const manager = new SubAgentManager();
    const sessionId = await manager.spawn(undefined, SubAgentType.RESEARCH, {
      description: 'd',
      input: {},
    });

    await expect(manager.execute(sessionId)).rejects.toThrow('SubAgentExecutor not set');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: real LLM provider (config-based; skip when provider missing)
// ---------------------------------------------------------------------------

let cachedConfig: Config | null | undefined;

function loadConfigOnce(): Config | null {
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

function getIntegrationProvider(name: 'doubao' | 'deepseek'): AIProvider | null {
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

function createAIManagerWithProvider(providerName: 'doubao' | 'deepseek'): AIManager {
  const manager = new AIManager();
  const provider = getIntegrationProvider(providerName);
  if (provider) {
    manager.registerProvider(provider);
    manager.setDefaultProvider('llm', providerName);
  }
  return manager;
}

const SUBAGENT_SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a given city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        unit: {
          type: 'string',
          description: 'Temperature unit',
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
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
];

const INTEGRATION_TIMEOUT_MS = 60_000;

/** Mock ToolRunner for integration tests: returns fixed get_weather/search results without ToolManager. */
const mockToolRunner: IToolRunner = {
  async run(call: FunctionCall, _session: SubAgentSession): Promise<unknown> {
    if (call.name === 'get_weather') {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      return {
        temperature: 25,
        unit: (args.unit as string) || 'celsius',
        condition: 'sunny',
        city: args.city,
      };
    }
    if (call.name === 'search') {
      return { results: ['No live search in test.'] };
    }
    return {};
  },
};

describe.skipIf(!getIntegrationProvider('doubao'))('SubAgentManager integration (real LLM - Doubao)', () => {
  const aiManager = createAIManagerWithProvider('doubao');
  const llmService = new LLMService(aiManager);
  const manager = new SubAgentManager();
  const executor: SubAgentExecutor = new SubAgentExecutorImpl(
    llmService,
    manager,
    SUBAGENT_SAMPLE_TOOLS,
    mockToolRunner,
  );
  manager.setExecutor(executor);

  test(
    'spawn + execute: sub-agent runs real LLM and returns text',
    async () => {
      const sessionId = await manager.spawn(undefined, SubAgentType.GENERIC, {
        description: 'Reply with only the number 42. No other text.',
        input: {},
      });
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.startsWith('agent:')).toBe(true);

      const result = await manager.execute(sessionId);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect((result as string).trim()).toContain('42');

      const session = manager.getStatus(sessionId);
      expect(session?.status).toBe('completed');
      expect(session?.task.output).toBe(result);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    'spawn + execute + wait: task using tool returns final answer',
    async () => {
      const sessionId = await manager.spawn(undefined, SubAgentType.RESEARCH, {
        description: 'Use get_weather for Beijing and reply with the weather in one short sentence.',
        input: { query: 'Beijing weather' },
      });

      const result = await manager.execute(sessionId);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);

      const output = await manager.wait(sessionId);
      expect(output).toBe(result);

      const session = manager.getStatus(sessionId);
      expect(session?.status).toBe('completed');
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
