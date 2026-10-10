/**
 * Coding Agent Service Initializer
 *
 * Handles initialization and lifecycle management of the coding-agent service.
 */

import { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { APIClient } from '@/api/APIClient';
import { FileAPI } from '@/api/methods/FileAPI';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config, ProtocolName } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ProjectRegistry } from '@/services/codingAgent/ProjectRegistry';
import { logger } from '@/utils/logger';
import { AgentToolBridge } from './AgentToolBridge';
import { CodingAgentService } from './CodingAgentService';

let serviceInstance: CodingAgentService | null = null;

export class CodingAgentInitializer {
  /**
   * Initialize the coding-agent service if enabled in config
   */
  static initialize(config: Config): CodingAgentService | null {
    const agentConfig = config.getCodingAgentConfig();

    if (!agentConfig?.enabled) {
      logger.debug('[CodingAgentInitializer] Coding agent service is disabled');
      return null;
    }

    serviceInstance = new CodingAgentService(agentConfig);

    // Nothing survives a restart to finish a task that was mid-flight, so close those
    // records now rather than let them claim forever that they are still running.
    const interrupted = serviceInstance.getTaskStore().closeInterruptedTasks('服务重启，任务中断');
    if (interrupted > 0) {
      logger.warn(`[CodingAgentInitializer] Closed ${interrupted} task record(s) interrupted by a restart`);
    }

    const container = getContainer();
    const registry = container.resolve(ProjectRegistry);
    serviceInstance.setProjectRegistry(registry);

    container.registerInstance(DITokens.CODING_AGENT_SERVICE, serviceInstance);

    logger.info('[CodingAgentInitializer] Coding agent service initialized');
    return serviceInstance;
  }

  /**
   * Start the coding-agent service
   */
  static async start(service: CodingAgentService | null, messageAPI: MessageAPI): Promise<void> {
    if (!service) {
      return;
    }

    const container = getContainer();
    service.attachDelivery({
      messageAPI,
      fileAPI: new FileAPI(container.resolve<APIClient>(DITokens.API_CLIENT)),
      historyService: container.resolve(ConversationHistoryService),
      cardRenderer: container.resolve(CardRenderingHelper),
    });
    service.attachBotTools(container.resolve(AgentToolBridge));

    // Set PromptManager from DI container
    try {
      const container = getContainer();
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
      service.setPromptManager(promptManager);
    } catch (error) {
      logger.warn('[CodingAgentInitializer] Failed to get PromptManager:', error);
    }

    await service.start();
  }

  /**
   * Update bot info in the service
   */
  static updateBotInfo(service: CodingAgentService | null, selfId: string | null, protocols: ProtocolName[]): void {
    if (service) {
      service.updateBotInfo(selfId, protocols);
    }
  }

  /**
   * Stop the coding-agent service
   */
  static async stop(service: CodingAgentService | null): Promise<void> {
    if (service) {
      await service.stop();
    }
  }

  /**
   * Get the service instance from DI container
   */
  static getService(): CodingAgentService | null {
    try {
      const container = getContainer();
      return container.resolve<CodingAgentService>(DITokens.CODING_AGENT_SERVICE);
    } catch {
      return null;
    }
  }
}
