// Core DI registrations: only what a class cannot declare for itself.
//
// Every other service is a @singleton() class that names its dependencies with @inject(...)
// and is built on first resolve, so it needs no entry here. What remains: values built
// outside the container, factories that assemble a registry from config, an interface
// token, and the fan-out multi-provider list.

import { AIService } from '@/ai/AIService';
import { createAIManager } from '@/ai/createAIManager';
import type { APIClient } from '@/api/APIClient';
import { AuditEventStore } from '@/conversation/audit/AuditEventStore';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health/HealthCheckManager';
import { FanoutInitializer } from '@/fanout/FanoutInitializer';
import { DefaultPermissionChecker } from '@/permission';
import { createTTSManager } from '@/services/tts/createTTSManager';
import { ToolInitializer } from '@/tools/ToolInitializer';

export function registerProviders(config: Config, apiClient: APIClient): void {
  const container = getContainer();

  // Built outside the container (the Bot owns the config; the API client is built from it).
  container.registerInstance(DITokens.CONFIG, config);
  container.registerInstance(DITokens.API_CLIENT, apiClient);

  // Registries whose contents come from config or decorator metadata, assembled on build.
  container.registerSingletonFactory(DITokens.AI_MANAGER, () => createAIManager(config));
  container.registerSingletonFactory(DITokens.TOOL_MANAGER, () => ToolInitializer.createToolManager());
  container.registerSingletonFactory(DITokens.TTS_MANAGER, (c) =>
    createTTSManager(config, c.resolve(HealthCheckManager)),
  );
  // Tool executors (e.g. ResearchToolExecutor) inject the AI facade's sub-agent manager.
  container.registerSingletonFactory(DITokens.SUB_AGENT_MANAGER, (c) => c.resolve(AIService).getSubAgentManager());

  container.registerAlias(DITokens.PERMISSION_CHECKER, DefaultPermissionChecker);
  // Undecorated on purpose: its options parameter exists for tests, and tsyringe builds a
  // class without constructor metadata by calling it with no arguments.
  container.registerSingleton(DITokens.AUDIT_EVENT_STORE, AuditEventStore);

  FanoutInitializer.registerProviders(container);
}
